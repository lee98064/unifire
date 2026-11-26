import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { ApprovalDecisionInput, ClientT, MeSummaryT } from '#shared/schemas/access'
import type { Db } from '../db'
import { clients, personDevices } from '../db/schema'
import { MINUTE, bedtimeWindows } from '../engine/access-time'
import { createBlockReconciler, desiredBlocks, setManualBlock } from '../engine/blocks'
import { updatePresence } from '../engine/presence'
import { createQuotaRoutes } from '../engine/quota-routes'
import { createUsageSampler, createUsageStore } from '../engine/samplers/usage'
import type { ControllerEvent } from '../unifi/ws'
import type { WriteContext } from '../unifi/writes'
import { apiError } from '../utils/api-error'
import { liveBus } from '../utils/bus'
import { createAuditService } from './audit'
import type { ControllerService } from './controller'
import { createExtensions } from './extensions'
import { createPeopleService } from './people'
import { createQuotaService } from './quotas'
import { createSettingsService } from './settings'

export function createAccess(db: Db, service: ControllerService, now = Date.now) {
  const config = createSettingsService(db)
  const audit = createAuditService(db)
  const usage = createUsageStore(db)
  const people = createPeopleService(db, service.engine, now)
  const quotas = createQuotaService(db, service.engine)
  const extensions = createExtensions(db, service.engine, people, quotas, () => config.get().timezone, now)
  const blocks = createBlockReconciler(db, service)
  const quotaRoutes = createQuotaRoutes(db, service, now)

  function desired(at = now()) {
    const settings = config.get()
    const persons = people.rows(at)
    const evaluated = quotas.evaluate(persons, at, settings.timezone, quotas.list().filter(quota => quota.enabled && quota.action.type === 'block'))
    return desiredBlocks(db, persons, evaluated, at, settings.timezone, settings.approval.mode === 'strict')
  }

  function quotaStatuses(personId?: string) {
    const at = now()
    const timezone = config.get().timezone
    if (personId === undefined) return quotas.evaluate(people.rows(at), at, timezone)
    const person = people.get(personId)
    const selected = quotas.list().filter(quota => {
      const { scope } = quota
      return quota.enabled && (scope.type === 'person' ? scope.id === person.id
        : scope.type === 'group' ? person.groupIds.includes(scope.id) : person.deviceMacs.includes(scope.id))
    })
    return quotas.evaluate([person], at, timezone, selected)
  }

  function approval(mac: string, input: z.output<typeof ApprovalDecisionInput>, ctx: WriteContext) {
    const row = db.select().from(clients).where(eq(clients.mac, mac)).get()
    if (!row) throw apiError(404, 'CLIENT_NOT_FOUND', 'errors.clientNotFound')
    const approval = input.decision === 'approve' ? 'approved' : input.decision === 'block' ? 'blocked' : 'ignored'
    if (row.approval !== 'pending' && row.approval !== approval) throw apiError(409, 'APPROVAL_NOT_PENDING', 'errors.approvalNotPending')
    let previous: string | undefined
    db.transaction(tx => {
      previous = tx.select().from(personDevices).where(eq(personDevices.mac, mac)).get()?.personId
      const person = input.decision === 'approve' ? input.personId : undefined
      if (person) people.get(person)
      if (person === null) tx.delete(personDevices).where(eq(personDevices.mac, mac)).run()
      else if (person && person !== previous) {
        tx.insert(personDevices).values({ mac, personId: person }).onConflictDoUpdate({
          target: personDevices.mac, set: { personId: person, presence: false },
        }).run()
      }
      tx.update(clients).set({ approval, alias: approval === 'approved' ? input.alias : undefined }).where(eq(clients.mac, mac)).run()
      if (approval === 'blocked') setManualBlock(tx, mac, null)
    })
    const name = (approval === 'approved' ? input.alias ?? row.alias : row.alias) || row.hostname || row.vendor || mac
    audit.record({ actor: ctx.actor, category: 'approval', action: 'approval.decided', severity: 'success',
      target: { type: 'client', id: mac, label: name },
      messageKey: `audit.approval.${approval}`, messageParams: { mac, name } })
    liveBus.emit({ type: 'client.changed', data: { macs: [mac] } })
    people.changed([previous, input.personId].filter((id): id is string => !!id))
    return blocks.reconcile(desired)
  }

  function summary(personId: string | null, listClients: (query: { personId: string }) => ClientT[]): MeSummaryT {
    if (!personId) return { person: null, devices: [], quotas: [], requests: [], blockedNow: false, blockReasons: [], nextBedtime: null }
    const person = people.get(personId)
    const devices = listClients({ personId })
    const reasons = new Map(devices.flatMap(device => device.blockReasons).map(reason => [
      JSON.stringify([reason.source, reason.refId, reason.until]), reason,
    ]))
    return {
      person, devices, quotas: quotaStatuses(personId).map(row => row.status), requests: extensions.list(undefined, personId),
      blockedNow: devices.some(device => device.blocked), blockReasons: [...reasons.values()],
      nextBedtime: bedtimeWindows(person.bedtime, now(), config.get().timezone, 7)[0] ?? null,
    }
  }

  function start(hasLease: () => boolean) {
    let stopped = false
    let requested = false
    let running: Promise<void> | undefined
    let sampling: Promise<void> | undefined
    let sampleTimer: ReturnType<typeof setTimeout> | undefined
    let sampledRuntime: ControllerService['runtime']
    let sampleUsage = createUsageSampler()

    function request() {
      if (stopped || !hasLease()) return
      requested = true
      running ??= Promise.resolve().then(async () => {
        while (requested && !stopped && hasLease()) {
          requested = false
          const at = now()
          const settings = config.get()
          const runtime = service.runtime
          const pollAt = runtime?.cache.activeClientsAt()
          extensions.expire(at)
          const persons = people.rows(at)
          if (runtime?.active() && pollAt != null && at - pollAt <= 45_000) {
            const online = new Set(runtime.cache.snapshot().activeClients.map(row => row.mac))
            updatePresence(db, service.engine, persons, online, pollAt, settings.presence.graceMinutes)
          }
          const evaluation = quotas.evaluate(persons, at, settings.timezone)
          quotas.transitions(evaluation)
          await blocks.reconcile(desired, at)
          if (runtime === service.runtime) await quotaRoutes(evaluation, persons).catch(() => {})
        }
      }).catch(() => {}).finally(() => {
        running = undefined
        if (requested) request()
      })
    }

    async function sample() {
      const runtime = service.runtime
      if (!runtime?.active()) return
      if (runtime !== sampledRuntime) {
        sampledRuntime = runtime
        sampleUsage = createUsageSampler()
      }
      const at = now()
      await runtime.cache.refresh('activeClients')
      if (stopped || !runtime.active() || runtime.cache.activeClientsAt() === null) return
      const settings = config.get()
      const rows = sampleUsage(runtime.cache.snapshot().activeClients, at, settings.usage.activeThresholdBytes)
      usage.record(rows, settings.timezone)
      usage.prune(at, settings.usage.retainRawDays)
      request()
    }

    function scheduleSample() {
      if (stopped) return
      sampleTimer = setTimeout(() => {
        sampling = sample().catch(() => {}).finally(() => { sampling = undefined; scheduleSample() })
      }, MINUTE - now() % MINUTE)
      sampleTimer.unref()
    }

    function onEvent(event: ControllerEvent) {
      if (event.type === 'access.changed' || event.type === 'routing.settings' || event.type === 'controller.mode'
        || event.type === 'controller.reconnected' || event.type === 'access.clientsChanged'
        || (event.type === 'cache.changed' && event.resource === 'networks')) request()
    }

    service.engine.on('event', onEvent)
    const timer = setInterval(request, 30_000)
    timer.unref()
    const ready = service.ready().then(() => {
      if (stopped) return
      request()
      scheduleSample()
    }).catch(() => {})
    return async () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(sampleTimer)
      service.engine.off('event', onEvent)
      await Promise.allSettled([ready, running, sampling])
    }
  }

  return { start, usage, people, quotas, quotaStatuses, extensions, blocks, approval, desired, summary }
}
