import { and, eq, gte, lt } from 'drizzle-orm'
import type { SnapshotResourceT } from '#shared/schemas/insight'
import type { Db } from '../db'
import { auditEvents, settings, unifiLogEntries } from '../db/schema'
import { createAuditService } from '../services/audit'
import type { ControllerService } from '../services/controller'
import { snapshotResources } from '../unifi/snapshot-resources'
import { serializeSite } from '../unifi/writes'
import type { ControllerEvent } from '../unifi/ws'
import { captureCollections } from './snapshots/capture'
import { compareMaps, digest, fieldDiff, labelResolver, type Collections } from './snapshots/diff'
import { DAY } from './snapshots/store'
import { describeSystemLog } from './unifi-log'

const watched = ['trafficroutes', 'objects', 'firewall-policies', 'wlanconf', 'portforward', 'networkconf', 'static-dns'] as const
const configurationEvent = /route|object|firewall|wlan|wifi|port.?forward|network.?conf|static.?dns|config/i
const external = { type: 'external', id: null, name: null } as const
const unifiLog = { type: 'unifi-log', id: null, name: null } as const
const lookback = 10 * 60_000
// Bumped when the way system-log rows are rendered changes; the next poll re-imports the last day once.
const LOG_FORMAT_KEY = 'audit.unifiLogFormat'
const LOG_FORMAT = 2

export function createAuditWatch(db: Db, service: ControllerService, now = Date.now) {
  const audit = createAuditService(db)
  let scope: string | undefined
  let baseline: Collections = new Map()
  let fingerprinting: Promise<void> | undefined
  let logging: Promise<void> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let fingerprintAgain = false
  let stopped = false

  function fingerprint() {
    if (fingerprinting) {
      fingerprintAgain = true
      return fingerprinting
    }
    const runtime = service.runtime
    if (stopped || !runtime?.active()) return
    fingerprinting = serializeSite(runtime.key, async () => {
      if (!runtime.active() || stopped) return
      const { collections } = await captureCollections(runtime.api, watched)
      if (!runtime.active() || stopped) return
      if (scope !== runtime.scope) {
        baseline = new Map()
        scope = runtime.scope
      }
      const oldLabel = labelResolver(baseline)
      const newLabel = labelResolver(collections)
      for (const [resource, current] of collections) {
        const before = baseline.get(resource)
        if (before) for (const { id, left, right } of compareMaps(before, current)) {
          if (runtime.ledger.explains(resource, id, left?.hash, right?.hash)) continue
          const label = right?.label ?? left!.label
          audit.record({
            category: snapshotResources[resource].category, actor: external, action: 'config.changed', severity: 'warning',
            target: { type: resource, id, label }, diff: fieldDiff(left?.doc ?? {}, right?.doc ?? {}, oldLabel, newLabel),
            messageKey: 'audit.config.externalChange', messageParams: { resource, label },
          })
          service.engine.emit('event', { type: 'config.external_change', resource, itemId: id, label })
        }
        baseline.set(resource, current)
      }
    }).finally(() => {
      fingerprinting = undefined
      if (fingerprintAgain && !stopped) { fingerprintAgain = false; requestSoon() }
    })
    return fingerprinting
  }

  function logs() {
    if (logging) return logging
    const runtime = service.runtime
    if (stopped || !runtime?.active() || !runtime.status.capabilities.some(value => value.key === 'systemlog' && value.status === 'ok')) return
    logging = (async () => {
      const end = now()
      const pageSize = 100
      const current = db.select().from(settings).where(eq(settings.key, LOG_FORMAT_KEY)).get()?.value === LOG_FORMAT
      if (!current) {
        // Earlier builds stored Network 11 rows as "[redacted]": drop the last day of imported rows and fetch them again.
        db.transaction(tx => {
          tx.delete(auditEvents).where(and(eq(auditEvents.actorType, 'unifi-log'), gte(auditEvents.ts, end - DAY))).run()
          tx.delete(unifiLogEntries).where(eq(unifiLogEntries.scope, runtime.scope)).run()
        })
      }
      const from = end - (current ? lookback : DAY)
      for (let page = 0; page < 10; page++) {
        const response = await runtime.api.systemLog('all', { pageNumber: page, pageSize, timestampFrom: from, timestampTo: end })
        if (!runtime.active() || stopped) return
        for (const row of response.data) {
          const time = row.timestamp ?? row.time ?? row.datetime
          const ts = typeof time === 'number' ? (time < 10_000_000_000 ? time * 1_000 : time)
            : typeof time === 'string' ? Date.parse(time) : end
          const eventTs = Number.isSafeInteger(ts) && ts >= 0 && ts <= end ? ts : end
          // Structured code + template rendered from parameter names only (see describeSystemLog).
          const { key, message, title, category, severity, target } = describeSystemLog(row)
          const entryId = row._id ?? row.id
          const fingerprint = digest(typeof entryId === 'string' ? entryId : [time ?? null, row])
          db.transaction(tx => {
            const added = tx.insert(unifiLogEntries).values({ scope: runtime.scope, fingerprint, ts: end }).onConflictDoNothing().run()
            if (!added.changes) return
            audit.record({ actor: unifiLog, category: 'system', action: 'unifi.log', severity, target,
              messageKey: 'audit.unifi.log', messageParams: { message, key, title, category } }, eventTs)
          })
        }
        if (response.data.length < pageSize || response.total_page_count != null && page + 1 >= response.total_page_count) break
      }
      if (!current) {
        db.insert(settings).values({ key: LOG_FORMAT_KEY, value: LOG_FORMAT })
          .onConflictDoUpdate({ target: settings.key, set: { value: LOG_FORMAT } }).run()
      }
      db.delete(unifiLogEntries).where(lt(unifiLogEntries.ts, end - DAY)).run()
    })().finally(() => { logging = undefined })
    return logging
  }

  function requestSoon() {
    if (debounce || stopped) return
    debounce = setTimeout(() => { debounce = undefined; void fingerprint()?.catch(() => {}) }, 1_000)
    debounce.unref()
  }

  function onEvent(event: ControllerEvent) {
    if (event.type === 'config.unifire_write' || event.type === 'controller.reconnected'
      || event.type === 'controller.event' && configurationEvent.test(event.key)
      || event.type === 'cache.changed' && (watched as readonly SnapshotResourceT[]).some(resource =>
        event.resource === snapshotResources[resource].path || event.resource === 'routes' || event.resource === 'networks')) requestSoon()
  }

  function start() {
    service.engine.on('event', onEvent)
    const begin = service.ready().then(() => {
      void fingerprint()?.catch(() => {})
      void logs()?.catch(() => {})
    })
    const configTimer = setInterval(() => { void fingerprint()?.catch(() => {}) }, 5 * 60_000)
    const logTimer = setInterval(() => { void logs()?.catch(() => {}) }, 2 * 60_000)
    configTimer.unref()
    logTimer.unref()
    return async () => {
      stopped = true
      clearTimeout(debounce)
      clearInterval(configTimer)
      clearInterval(logTimer)
      service.engine.off('event', onEvent)
      await Promise.allSettled([begin, fingerprinting, logging])
      baseline.clear()
    }
  }

  return { fingerprint, logs, start }
}
