import { lt } from 'drizzle-orm'
import type { SnapshotResourceT } from '#shared/schemas/insight'
import type { Db } from '../db'
import { unifiLogEntries } from '../db/schema'
import { createAuditService } from '../services/audit'
import type { ControllerService } from '../services/controller'
import { snapshotResources } from '../unifi/snapshot-resources'
import { serializeSite } from '../unifi/writes'
import type { ControllerEvent } from '../unifi/ws'
import { captureCollections } from './snapshots/capture'
import { compareMaps, digest, fieldDiff, labelResolver, type Collections } from './snapshots/diff'
import { DAY } from './snapshots/store'

const watched = ['trafficroutes', 'objects', 'firewall-policies', 'wlanconf', 'portforward', 'networkconf', 'static-dns'] as const
const configurationEvent = /route|object|firewall|wlan|wifi|port.?forward|network.?conf|static.?dns|config/i
const external = { type: 'external', id: null, name: null } as const
const unifiLog = { type: 'unifi-log', id: null, name: null } as const
const lookback = 10 * 60_000
const logMessages = new Set(['EVT_LU_Connected', 'EVT_LU_Disconnected', 'EVT_WU_Connected', 'EVT_WU_Disconnected',
  'EVT_WU_Roam', 'EVT_WU_RoamRadio', 'EVT_RouteUpdated', 'EVT_PortForwardUpdated'])

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
      for (let page = 0; page < 10; page++) {
        const response = await runtime.api.systemLog('all', { pageNumber: page, pageSize, timestampFrom: end - lookback, timestampTo: end })
        if (!runtime.active() || stopped) return
        for (const row of response.data) {
          const time = row.timestamp ?? row.time ?? row.datetime
          const ts = typeof time === 'number' ? (time < 10_000_000_000 ? time * 1_000 : time)
            : typeof time === 'string' ? Date.parse(time) : end
          const eventTs = Number.isSafeInteger(ts) && ts >= 0 && ts <= end ? ts : end
          const rawKey = row.key ?? row.eventKey ?? row.event_key
          const key = typeof rawKey === 'string' && /^EVT_[A-Za-z0-9_]{1,80}$/.test(rawKey) ? rawKey : 'unifi.event'
          // UniFi can interpolate controller data and secrets into arbitrary prose. Keep only a structured event code.
          const message = logMessages.has(key) ? key : '[redacted]'
          const entryId = row._id ?? row.id
          const fingerprint = digest(typeof entryId === 'string' ? entryId : [time ?? null, row])
          db.transaction(tx => {
            const added = tx.insert(unifiLogEntries).values({ scope: runtime.scope, fingerprint, ts: end }).onConflictDoNothing().run()
            if (!added.changes) return
            audit.record({ actor: unifiLog, category: 'system', action: 'unifi.log', severity: 'info',
              messageKey: 'audit.unifi.log', messageParams: { message, key } }, eventTs)
          })
        }
        if (response.data.length < pageSize || response.total_page_count != null && page + 1 >= response.total_page_count) break
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
