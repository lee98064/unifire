import { isIPv4 } from 'node:net'
import { and, eq } from 'drizzle-orm'
import { ProbeOverview } from '#shared/schemas/egress'
import type { Db } from '../../db'
import { egresses, settings } from '../../db/schema'
import { createAuditService } from '../../services/audit'
import { systemContext, type ControllerService } from '../../services/controller'
import { classifyRoute, PROBE_PREFIX, routeFingerprint } from '../../services/ownership'
import { routeDraft } from '../../services/route-shape'
import { createSettingsService } from '../../services/settings'
import { UnifiError, unifiErrorCode, unifiStatusKey } from '../../unifi/errors'
import type { WireRoute } from '../../unifi/endpoints/schemas'
import { serializeSite, type WriteContext } from '../../unifi/writes'

export const SWEEP_IPS = ['1.1.1.1', '1.0.0.1'] as const
export const SWEEP_NAME = `${PROBE_PREFIX} sweep`
type EgressRow = typeof egresses.$inferSelect
type Runtime = NonNullable<ControllerService['runtime']>
const probeName = (name: string) => name === 'sweep' ? `${PROBE_PREFIX} sweep (egress)` : `${PROBE_PREFIX} ${name}`
const reserved = new Set<string>(SWEEP_IPS)

function draftFor(mac: string, name: string, egressId: string, ips: string[], enabled = true) {
  return routeDraft({ name, targets: [{ type: 'CLIENT', mac }], matchingTarget: 'IP', destinations: ips,
    defaultEgressId: egressId, killSwitch: true, enabled })
}

export function createProbeRoutes(db: Db, service: ControllerService) {
  const audit = createAuditService(db)
  function report(ctx: WriteContext, created: number, repaired: number, removed: number) {
    if (!created && !repaired && !removed) return
    audit.record({ actor: ctx.actor, category: 'egress', action: 'egress.probesProvisioned', severity: 'info',
      messageKey: 'audit.egress.probesProvisioned',
      messageParams: { created: String(created), repaired: String(repaired), removed: String(removed) } })
  }
  const config = createSettingsService(db)
  const errors = new Map<string, string>()
  const provisioning = new Set<string>()
  let work: Promise<unknown> | undefined
  const queue = <T>(task: () => Promise<T>) => {
    const next = serializeSite('unifire-probe-routes', task)
    work = next
    void next.finally(() => { if (work === next) work = undefined }).catch(() => {})
    return next
  }

  function exits(run = service.runtime) {
    if (!run) return []
    const present = new Set(run.cache.snapshot().networks.map(network => network._id))
    return db.select().from(egresses).where(eq(egresses.site, run.config.site)).all()
      .filter(row => present.has(row.id)).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  }

  function sweepId(run: Runtime) {
    const id = db.select().from(settings).where(eq(settings.key, `routing.sweepRoute:${run.scope}`)).get()?.value
    return typeof id === 'string' ? id : null
  }

  function saveSweep(run: Runtime, id: string) {
    db.insert(settings).values({ key: `routing.sweepRoute:${run.scope}`, value: id })
      .onConflictDoUpdate({ target: settings.key, set: { value: id } }).run()
  }

  function setExit(row: EgressRow, patch: Partial<EgressRow>) {
    db.update(egresses).set(patch).where(and(eq(egresses.id, row.id), eq(egresses.site, row.site))).run()
  }

  function probeState(row: EgressRow, run = service.runtime, docs = run?.cache.snapshot().routes ?? []) {
    const routeId = run && row.probeRouteScope === run.scope ? row.probeRouteId : null
    const info = { egressId: row.id, routeId, ip: row.probeIp, detail: null }
    if (!row.probeEnabled || !row.enabled) return { ...info, state: 'disabled' as const }
    if (provisioning.has(row.id)) return { ...info, state: 'provisioning' as const }
    const doc = docs.find(route => route._id === routeId)
    const mac = service.status().selfMac
    const detail = errors.get(row.id)
    if (!doc || !run) {
      return detail && service.status().mode === 'live' ? { ...info, state: 'error' as const, detail }
        : { ...info, routeId: null, state: 'missing' as const }
    }
    if (!mac || !row.probeIp || classifyRoute(doc, service.ownership(run.config.site)) !== 'probe'
      || !matches(doc, draftFor(mac, probeName(row.name), row.id, [row.probeIp]))) {
      return { ...info, state: 'error' as const, detail: detail ?? 'probe.detail.drift' }
    }
    return { ...info, state: 'ok' as const }
  }

  function overview() {
    return ProbeOverview.parse({ selfMac: service.status().selfMac, ipPool: config.get().probe.ipPool,
      sweepIp: SWEEP_IPS[0], routes: exits().map(row => probeState(row)) })
  }

  function matches(doc: WireRoute, draft: ReturnType<typeof draftFor>) {
    return routeFingerprint(doc) === routeFingerprint({ ...draft, _id: doc._id })
      && doc.description === draft.description && doc.network_id === draft.network_id
  }

  async function provision(ctx: WriteContext = systemContext, repair = true) {
    return queue(async () => {
      const run = service.runtime
      if (!run?.active()) {
        if (repair) throw new UnifiError('UNIFI_NOT_CONFIGURED')
        return overview()
      }
      const status = service.status()
      const quiet = { ...ctx, quietProbe: true }
      let created = 0
      let repaired = 0
      if (!repair && (!status.connected || status.mode !== 'live')) return overview()
      const rows = exits(run)
      if (!rows.some(row => row.probeEnabled && row.enabled || row.probeRouteScope === run.scope && row.probeRouteId)) return overview()
      // Live writes are refused until the write check passed: say so once per egress instead of
      // attempting (and auditing a failed write) on every 30-second reconcile.
      if (status.mode === 'live' && !run.writes.qualified()) {
        for (const row of rows) if (row.enabled && row.probeEnabled) errors.set(row.id, 'errors.unifiQualificationRequired')
        if (repair) throw new UnifiError('UNIFI_QUALIFICATION_REQUIRED', 409)
        return overview()
      }
      const docs = await run.api.routes()
      if (!run.active()) throw new UnifiError('UNIFI_INACTIVE')
      const mac = status.selfMac
      const pool = Array.from(new Set(config.get().probe.ipPool.filter(ip => isIPv4(ip) && !reserved.has(ip))))
      const used = new Set<string>()
      const scopedRows = db.select().from(egresses).where(eq(egresses.site, run.config.site)).all()
      const assigned = new Map<string, string>()
      for (const row of scopedRows) {
        if (row.probeIp && isIPv4(row.probeIp) && !reserved.has(row.probeIp) && !used.has(row.probeIp)) {
          used.add(row.probeIp)
          assigned.set(row.id, row.probeIp)
        }
      }
      for (const row of rows) {
        if (!run.active()) break
        const doc = docs.find(route => row.probeRouteScope === run.scope && route._id === row.probeRouteId)
        if (!row.enabled || !row.probeEnabled) {
          if (doc?.enabled) {
            await run.writes.repairProbe(doc._id, { enabled: false }, quiet).then(result => {
              if (!result.dryRun && result.changed) repaired++
            }).catch(error => {
              errors.set(row.id, unifiStatusKey(unifiErrorCode(error)) ?? 'errors.unifiRequestFailed')
            })
          }
          continue
        }
        const ip = assigned.get(row.id) ?? pool.find(ip => !used.has(ip))
        if (!mac || !ip) {
          errors.set(row.id, !mac ? 'probe.detail.selfMacRequired' : 'probe.detail.ipPoolExhausted')
          continue
        }
        used.add(ip)
        if (row.probeIp !== ip) setExit(row, { probeIp: ip })
        const draft = draftFor(mac, probeName(row.name), row.id, [ip])
        if (doc && !repair && (doc.enabled || !matches(doc, { ...draft, enabled: false }))) continue
        provisioning.add(row.id)
        try {
          if (doc) {
            if (!matches(doc, draft)) {
              const result = await run.writes.repairProbe(doc._id, draft, quiet)
              if (!result.dryRun && result.changed) repaired++
            }
          } else {
            // An unregistered rule at this exact source and destination could capture probe traffic.
            const overlap = docs.some(route => route.description?.startsWith(PROBE_PREFIX)
              && route.target_devices.some(target => target.client_mac === mac)
              && route.ip_addresses?.some(address => (typeof address === 'string' ? address : address.ip_or_subnet) === ip))
            if (overlap) {
              audit.record({ actor: ctx.actor, category: 'egress', action: 'egress.probeOverlap', severity: 'warning',
                messageKey: 'audit.egress.probeOverlap', messageParams: { egress: row.name } })
              throw new UnifiError('ROUTE_NOT_OWNED')
            }
            const result = await run.writes.createRoute(draft, quiet, { created: id => {
              if (run.active()) setExit(row, { probeRouteId: id, probeRouteScope: run.scope })
            } })
            if (!result.dryRun && result.changed) created++
          }
          errors.delete(row.id)
        } catch (error) {
          const code = unifiErrorCode(error)
          errors.set(row.id, code === 'UNIFI_QUALIFICATION_REQUIRED' ? 'errors.unifiQualificationRequired'
            : unifiStatusKey(code) ?? 'errors.unifiRequestFailed')
        } finally {
          provisioning.delete(row.id)
        }
      }
      await run.cache.refresh('routes').catch(() => {})
      report(ctx, created, repaired, 0)
      return overview()
    })
  }

  function cleanup(ctx: WriteContext) {
    return queue(async () => {
      const run = service.runtime
      if (!run?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
      const docs = await run.api.routes()
      const rows = db.select().from(egresses).where(and(eq(egresses.site, run.config.site), eq(egresses.probeRouteScope, run.scope))).all()
      const targets = new Set([...rows.map(row => row.probeRouteId), sweepId(run)])
      let removed = 0
      let failure: unknown
      for (const id of targets) {
        if (!id) continue
        try {
          const result = docs.some(route => route._id === id) ? await run.writes.deleteRoute(id, { ...ctx, quietProbe: true })
            : { changed: false, dryRun: service.status().mode === 'dry-run' || ctx.dryRun === true }
          if (result.dryRun || !run.active()) continue
          if (result.changed) removed++
          const row = rows.find(row => row.probeRouteId === id)
          if (row) {
            setExit(row, { probeRouteId: null })
            errors.delete(row.id)
          } else db.delete(settings).where(eq(settings.key, `routing.sweepRoute:${run.scope}`)).run()
        } catch (error) { failure ??= error }
      }
      await run.cache.refresh('routes').catch(() => {})
      report(ctx, 0, 0, removed)
      if (failure) throw failure
      return overview()
    })
  }

  async function ensureSweep(run: Runtime, mac: string, egressId: string, ctx: WriteContext) {
    const docs = await run.api.routes()
    const current = docs.find(doc => doc._id === sweepId(run))
    const draft = draftFor(mac, SWEEP_NAME, current?.network_id || egressId, SWEEP_IPS.map(ip => `${ip}/32`), false)
    if (current) {
      if (!matches(current, draft) || classifyRoute(current, service.ownership(run.config.site)) !== 'probe') {
        await run.writes.repairProbe(current._id, draft, { ...ctx, quietProbe: true })
      }
      return { id: current._id, draft }
    }
    if (docs.some(doc => doc.description === SWEEP_NAME)) throw new UnifiError('ROUTE_NOT_OWNED')
    const result = await run.writes.createRoute(draft, { ...ctx, quietProbe: true }, { created: id => {
      if (run.active()) saveSweep(run, id)
    } })
    if (result.id === null) throw new UnifiError('SWEEP_DRY_RUN')
    return { id: result.id, draft }
  }

  return { exits, probeState, overview, provision, cleanup, ensureSweep, sweepId, idle: () => work }
}
