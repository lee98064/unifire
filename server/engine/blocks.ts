import { and, eq, lte } from 'drizzle-orm'
import type { BlockReasonT, PersonT } from '#shared/schemas/access'
import type { Db } from '../db'
import { appliedClientBlocks, blocks, clients } from '../db/schema'
import { createAuditService } from '../services/audit'
import { systemContext, type ControllerService } from '../services/controller'
import type { QuotaEvaluation } from '../services/quotas'
import { UnifiError } from '../unifi/errors'
import { serializeSite, type WriteContext } from '../unifi/writes'
import { liveBus } from '../utils/bus'
import { MINUTE, bedtimeWindows } from './access-time'

export function setManualBlock(db: Pick<Db, 'insert'>, mac: string, until: number | null) {
  const id = `manual:${mac}`
  db.insert(blocks).values({ id, mac, source: 'manual', label: 'block.manual', until })
    .onConflictDoUpdate({ target: blocks.id, set: { until } }).run()
}

export function desiredBlocks(db: Db, people: PersonT[], quotas: QuotaEvaluation[], at: number, timezone: string, strict: boolean) {
  const result = new Map<string, BlockReasonT[]>()
  const add = (mac: string, source: BlockReasonT['source'], refId: string | null, until: number | null) => {
    const reasons = result.get(mac) ?? []
    reasons.push({ source, refId, label: `block.${source}`, until })
    result.set(mac, reasons)
  }
  for (const row of db.select().from(blocks).all()) {
    if ((row.source === 'manual' || row.source === 'rule') && (row.until === null || row.until > at)) {
      add(row.mac, row.source, row.refId, row.until)
    }
  }
  if (strict) {
    for (const row of db.select().from(clients).where(eq(clients.approval, 'pending')).all()) add(row.mac, 'approval', null, null)
  }
  const allowed = new Set(people.filter(person => person.allowanceUntil !== null && person.allowanceUntil > at).map(person => person.id))
  for (const person of people) {
    if (allowed.has(person.id) || !person.deviceMacs.length) continue
    const bedtimeEnd = Math.max(0, ...bedtimeWindows(person.bedtime, at, timezone)
      .filter(window => window.start <= at).map(window => window.end))
    for (const mac of person.deviceMacs) {
      if (person.pause.active) add(mac, 'pause', person.id, person.pause.until)
      if (bedtimeEnd) add(mac, 'bedtime', person.id, bedtimeEnd)
    }
  }
  for (const { quota, status, personId, macs } of quotas) {
    if (!quota.enabled || quota.action.type !== 'block' || status.state !== 'exceeded' || personId && allowed.has(personId)) continue
    for (const mac of macs) add(mac, 'quota', quota.id, status.resetsAt)
  }
  return result
}

export function ownedBlocks(db: Db, scope?: string) {
  return new Set(!scope ? [] : db.select({ mac: appliedClientBlocks.mac }).from(appliedClientBlocks)
    .where(eq(appliedClientBlocks.controllerScope, scope)).all().map(row => row.mac))
}

export function createBlockReconciler(db: Db, service: ControllerService) {
  const audit = createAuditService(db)
  const previews = new Map<string, string>()
  const queue = <T>(work: () => T | Promise<T>) => serializeSite('unifire-access-blocks', work)

  function requireRuntime() {
    const runtime = service.runtime
    if (!runtime?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    return runtime
  }

  type Runtime = ReturnType<typeof requireRuntime>

  async function converge(runtime: Runtime, mac: string, desired: boolean, ctx: WriteContext) {
    const { api, writes, scope } = runtime
    const key = and(eq(appliedClientBlocks.controllerScope, scope), eq(appliedClientBlocks.mac, mac))
    const fresh = async () => {
      const saved = (await api.knownClients()).find(row => row.mac === mac)
      return saved?.blocked ?? (await api.activeClients()).find(row => row.mac === mac)?.blocked
    }
    let physical = false
    let local = false
    const result = await writes.clientAction(mac, desired ? 'block' : 'unblock', { ...ctx, quietSuccess: true }, async () => {
      const owned = !!db.select().from(appliedClientBlocks).where(key).get()
      const wasBlocked = await fresh()
      if (wasBlocked == null) throw new UnifiError('UNIFI_CLIENT_STATE_UNKNOWN')
      const send = desired ? !wasBlocked : owned && wasBlocked
      if (owned && !wasBlocked) db.delete(appliedClientBlocks).where(key).run()
      physical = wasBlocked
      local = owned && wasBlocked
      return {
        wasBlocked, send,
        async verify() {
          if (await fresh() !== desired) throw new UnifiError('UNIFI_VERIFY_FAILED')
          physical = desired
          local = desired
        },
        commit() {
          db.transaction(tx => {
            if (local) tx.insert(appliedClientBlocks).values({ controllerScope: scope, mac }).onConflictDoNothing().run()
            else if (owned) tx.delete(appliedClientBlocks).where(key).run()
            tx.update(blocks).set({ applied: local }).where(and(eq(blocks.mac, mac), eq(blocks.source, 'manual'))).run()
          })
        },
      }
    })
    if (result.changed) {
      audit.record({ actor: ctx.actor, category: 'client', action: desired ? 'client.block' : 'client.unblock',
        severity: result.dryRun ? 'info' : 'success', target: { type: 'client', id: mac, label: mac },
        dryRun: result.dryRun, diff: result.diff,
        messageKey: desired ? 'audit.block.applied' : 'audit.block.released', messageParams: { mac } })
      if (!result.dryRun) await refresh(runtime, mac)
    }
    return { physical, local, ...result }
  }

  async function refresh(runtime: Runtime, mac: string) {
    for (const resource of ['knownClients', 'activeClients'] as const) {
      await runtime.cache.refresh(resource).catch(() => {})
      await runtime.cache.refresh(resource).catch(() => {})
    }
    liveBus.emit({ type: 'client.changed', data: { macs: [mac] } })
  }

  function reconcile(readDesired: () => Map<string, BlockReasonT[]>, at = Date.now()) {
    return queue(async () => {
      const runtime = service.runtime
      if (!runtime?.active()) return
      const desired = readDesired()
      const owned = ownedBlocks(db, runtime.scope)
      const { knownClients, activeClients } = runtime.cache.snapshot()
      const actual = new Map(activeClients.map(row => [row.mac, row.blocked]))
      for (const row of knownClients) if (row.blocked != null || !actual.has(row.mac)) actual.set(row.mac, row.blocked)
      const live = service.status().mode === 'live'
      if (live) previews.clear()
      for (const mac of new Set([...desired.keys(), ...owned])) {
        if (!runtime.active()) return
        const want = desired.has(mac)
        const ours = owned.has(mac)
        const cached = actual.get(mac)
        if (!actual.has(mac) || (want ? cached === true : !ours)) continue
        const key = JSON.stringify([runtime.scope, mac, want, cached])
        if (!live && previews.get(mac) === key) continue
        try {
          const result = await converge(runtime, mac, want, systemContext)
          if (result.dryRun) previews.set(mac, key)
        } catch { /* The gate records failed writes. Retry the next cycle. */ }
      }
      if (!runtime.active()) return
      const expired = db.select({ mac: blocks.mac }).from(blocks).where(lte(blocks.until, at)).all()
      db.delete(blocks).where(lte(blocks.until, at)).run()
      if (expired.length) liveBus.emit({ type: 'client.changed', data: { macs: [...new Set(expired.map(row => row.mac))] } })
    })
  }

  function action(mac: string, name: 'block' | 'unblock' | 'kick', ctx: WriteContext, readDesired: () => Map<string, BlockReasonT[]>,
    minutes?: number) {
    return queue(async () => {
      const runtime = requireRuntime()
      if (name === 'kick') {
        const result = await runtime.writes.clientAction(mac, name, ctx, async () => ({ send: true }))
        if (!result.dryRun) await refresh(runtime, mac)
      } else {
        const live = service.status().mode === 'live' && !ctx.dryRun
        if (live) {
          if (name === 'block') setManualBlock(db, mac, minutes === undefined ? null : Date.now() + minutes * MINUTE)
          else db.delete(blocks).where(and(eq(blocks.mac, mac), eq(blocks.source, 'manual'))).run()
        }
        const other = readDesired().get(mac)?.some(reason => reason.source !== 'manual') ?? false
        await converge(runtime, mac, name === 'block' || other, ctx)
      }
    }).finally(() => {
      liveBus.emit({ type: 'client.changed', data: { macs: [mac] } })
      service.engine.emit('event', { type: 'access.changed' })
    })
  }

  return { reconcile, action }
}
