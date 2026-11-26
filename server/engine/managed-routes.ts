import type { AuditEventT } from '#shared/schemas/insight'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { Paged } from '#shared/schemas/common'
import {
  FailoverPolicy, ManagedRoute, RoutePreview, SwitchLogEntry, type ManagedRouteCreateInputT,
  type ManagedRouteUpdateInput, type OverrideInput, type RouteScheduleT, type SwitchReasonT,
} from '#shared/schemas/routes'
import type { UpcomingSwitchT } from '#shared/schemas/system'
import type { Db } from '../db'
import { egressHealth, egresses, managedRoutes, routeOverrides, routeSchedules, routeSwitchLog } from '../db/schema'
import { createAuditService, decodeCursor } from '../services/audit'
import { systemContext, type ControllerService } from '../services/controller'
import { classifyRoute, PROBE_PREFIX, QUOTA_PREFIX, routeFingerprint } from '../services/ownership'
import { managedRouteShape, routeDraft } from '../services/route-shape'
import { createSettingsService, validateTimezone } from '../services/settings'
import { isUnsupported, UnifiError, unifiErrorCode, unifiStatusKey } from '../unifi/errors'
import { serializeSite, type WriteContext } from '../unifi/writes'
import type { WireRoute } from '../unifi/endpoints/schemas'
import { apiError } from '../utils/api-error'
import { liveBus } from '../utils/bus'
import { clearFailover, plannedEgress, previewSegments, resolveEgress } from './route-desired'

type Row = typeof managedRoutes.$inferSelect
type Runtime = NonNullable<ControllerService['runtime']>
export const defaultFailover = FailoverPolicy.parse({ enabled: false, chain: [] })
const HOUR = 3_600_000
export const QUOTA_OVERRIDE_ACTOR = 'rule:quota'
const emptyShape = { matchingTarget: 'INTERNET', targets: [], destinations: [], killSwitch: false } as const

export function createManagedRoutes(db: Db, service: ControllerService, now = Date.now) {
  const audit = createAuditService(db, liveBus, now)
  const settings = createSettingsService(db)
  const dryIntents = new Map<string, string>()
  const queue = <T>(work: () => T | Promise<T>) => serializeSite('unifire-managed-routes', work)
  const rows = () => [...service.ownership(service.runtime?.config.site ?? service.status().site ?? 'default').managed.values()]
  function set(id: string, patch: Partial<Row>) {
    if (Object.values(patch).some(value => value !== undefined)) db.update(managedRoutes).set(patch).where(eq(managedRoutes.id, id)).run()
  }
  function health(at = now()) {
    const freshAfter = at - 2_000 * settings.get().probe.intervalSec
    return new Map(db.select().from(egressHealth).all()
      .filter(row => row.value.lastCheckAt !== null && row.value.lastCheckAt >= freshAfter)
      .map(row => [row.egressId, row]))
  }

  function exits() {
    const runtime = service.runtime
    const present = new Set(runtime?.cache.snapshot().networks.map(network => network._id))
    return db.select().from(egresses).where(eq(egresses.site, runtime?.config.site ?? 'default')).all()
      .filter(row => present.has(row.id))
  }

  function validateExits(ids: Iterable<string | null | undefined>) {
    const present = new Set(exits().map(exit => exit.id))
    for (const id of ids) if (id != null && !present.has(id)) throw new UnifiError('EGRESS_NOT_FOUND', 404)
  }

  function runtime() {
    const value = service.runtime
    if (!value) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    if (!value.active()) throw new UnifiError('UNIFI_INACTIVE')
    return value
  }

  function find(id: string) {
    const row = rows().find(route => route.id === id)
    if (!row) throw apiError(404, 'MANAGED_ROUTE_NOT_FOUND', 'errors.managedRouteNotFound')
    return row
  }

  function timing(row: Row, at: number) {
    const schedule = db.select().from(routeSchedules).where(eq(routeSchedules.managedRouteId, row.id)).get() ?? null
    const override = db.select().from(routeOverrides).where(and(eq(routeOverrides.managedRouteId, row.id),
      lte(routeOverrides.startsAt, at), gt(routeOverrides.endsAt, at)))
      .orderBy(sql`case when ${routeOverrides.createdBy} = ${QUOTA_OVERRIDE_ACTOR} then 1 else 0 end`,
        desc(routeOverrides.startsAt), desc(routeOverrides.id)).get() ?? null
    return { defaultEgressId: row.defaultEgressId, schedule, override }
  }

  function changed(id: string, trigger = true) {
    liveBus.emit({ type: 'route.changed', data: { managedRouteId: id } })
    if (trigger) service.engine.emit('event', { type: 'routing.changed', managedRouteId: id })
  }

  function record(row: Pick<Row, 'id' | 'name'>, action: string, ctx: WriteContext) {
    audit.record({ actor: ctx.actor, category: 'route', action, severity: 'success',
      target: { type: 'route', id: row.id, label: row.name },
      messageKey: 'audit.route.managedChanged', messageParams: { route: row.name, action } })
  }

  function view(row: Row, doc?: WireRoute, at = now()) {
    const time = timing(row, at)
    const planned = plannedEgress(time, at)
    const calc = resolveEgress(time, row.failover, row, health(at), at, new Set(exits().filter(exit => exit.enabled).map(exit => exit.id)), doc?.network_id)
    const atNext = planned.until
    const next = atNext === null ? null : { at: atNext, ...plannedEgress(time, atNext) }
    return ManagedRoute.parse({
      ...emptyShape, ...(row.routeShape ?? (doc && managedRouteShape(doc))), ...row,
      actualEgressId: doc?.network_id || null, schedule: time.schedule, activeOverride: time.override,
      desired: calc.desired, next: row.enabled ? next : null,
    })
  }

  function get(id: string, doc?: WireRoute) {
    const row = find(id)
    return view(row, doc ?? service.runtime?.cache.snapshot().routes.find(route => route._id === row.unifiRouteId))
  }

  async function fresh(run: Runtime, id: string) {
    const doc = (await run.api.routes()).find(route => route._id === id)
    if (!run.active()) throw new UnifiError('UNIFI_INACTIVE')
    if (!doc) throw new UnifiError('UNIFI_ROUTE_NOT_FOUND', 404)
    return doc
  }

  function shape(doc: WireRoute) {
    const value = managedRouteShape(doc)
    if (!value || doc.next_hop) throw apiError(409, 'ROUTE_SHAPE_UNSUPPORTED', 'errors.routeShapeUnsupported')
    return value
  }

  const create = (input: ManagedRouteCreateInputT, ctx: WriteContext) => queue(async () => {
    const run = runtime()
    const at = now()
    const common = { id: randomUUID(), controllerScope: run.scope, site: run.config.site, failover: defaultFailover, createdAt: at }
    if (input.mode === 'adopt') {
      const docs = await run.api.routes()
      if (!run.active()) throw new UnifiError('UNIFI_INACTIVE')
      run.observations.observe(docs, now(), at)
      const doc = docs.find(route => route._id === input.unifiRouteId)
      if (!doc) throw new UnifiError('UNIFI_ROUTE_NOT_FOUND', 404)
      if (classifyRoute(doc, service.ownership(run.config.site)) !== 'external' || [PROBE_PREFIX, QUOTA_PREFIX].some(prefix => doc.description?.startsWith(prefix))) {
        throw new UnifiError('ROUTE_NOT_OWNED')
      }
      if (run.observations.details(doc._id, at).suspectedAutomation && !input.acknowledgeAutomation) {
        throw apiError(409, 'ROUTE_EXTERNALLY_AUTOMATED', 'errors.routeExternallyAutomated')
      }
      const routeShape = shape(doc)
      const defaultEgressId = input.defaultEgressId ?? doc.network_id
      if (!defaultEgressId) throw new UnifiError('EGRESS_NOT_FOUND', 404)
      validateExits([defaultEgressId])
      const row = db.insert(managedRoutes).values({ ...common, unifiRouteId: doc._id, defaultEgressId,
        name: input.name ?? (doc.description || `UniFi ${doc._id.slice(-6)}`), routeShape, state: 'active',
        baselineFingerprint: routeFingerprint(doc) }).returning().get()
      record(row, 'route.adopted', ctx)
      changed(row.id)
      return view(row, doc)
    }

    validateExits([input.defaultEgressId])
    if ([PROBE_PREFIX, QUOTA_PREFIX].some(prefix => input.name.startsWith(prefix))) throw apiError(400, 'ROUTE_RESERVED_NAME', 'errors.routeReservedName')
    if (input.matchingTarget !== 'INTERNET' && input.destinations.length === 0) {
      throw apiError(400, 'ROUTE_DESTINATIONS_REQUIRED', 'errors.routeDestinationsRequired')
    }
    const unsupported = () => apiError(409, 'ROUTE_CREATE_UNSUPPORTED', 'errors.routeCreateUnsupported')
    const status = service.status()
    const capability = status.capabilities.find(capability => capability.key === 'routes.create')
    if (capability?.status === 'fail' || (!status.mock && status.mode === 'live' && capability?.status !== 'ok')) throw unsupported()
    const draft = routeDraft(input)
    let created: WireRoute | undefined
    let recorded = false
    const result = await run.writes.createRoute(draft, ctx, {
      created(unifiRouteId) {
        if (!run.active()) return
        const doc = { ...draft, _id: unifiRouteId }
        db.insert(managedRoutes).values({ ...common, name: input.name, unifiRouteId, defaultEgressId: input.defaultEgressId,
          routeShape: shape(doc), state: 'pending', createdByUnifire: true, baselineFingerprint: routeFingerprint(doc),
        }).run()
        recorded = true
      },
      verified(doc) { created = doc },
    }).catch(error => {
      // If the controller assigned an ID, keep ownership for convergence after verification failed.
      if (recorded && run.active()) {
        set(common.id, { state: 'error', stateDetail: unifiStatusKey(unifiErrorCode(error)) })
        changed(common.id)
      }
      if (isUnsupported(error)) throw unsupported()
      throw error
    })
    if (!run.active()) throw new UnifiError('UNIFI_INACTIVE')
    if (!result.id) {
      return ManagedRoute.parse({
        ...common, ...input, unifiRouteId: `dry-run:${common.id}`, state: 'pending', stateDetail: 'route.state.dryRun',
        enabled: true, schedule: null, actualEgressId: null, desired: { egressId: input.defaultEgressId, reason: 'initial', until: null },
        activeOverride: null, next: null, lastSwitchAt: null,
      })
    }
    const doc = created ?? { ...draft, _id: result.id }
    set(common.id, { routeShape: shape(doc), baselineFingerprint: routeFingerprint(doc), state: 'active' })
    record({ id: common.id, name: input.name }, 'route.created', ctx)
    changed(common.id)
    return get(common.id, doc)
  })

  function state(row: Row, next: Row['state'], stateDetail: string | null) {
    if (row.state === next && row.stateDetail === stateDetail) return
    set(row.id, { state: next, stateDetail })
    changed(row.id, false)
    if (next !== 'drift') return
    audit.record({ actor: systemContext.actor, category: 'route', action: 'route.drift', severity: 'warning',
      target: { type: 'route', id: row.id, label: row.name },
      messageKey: 'audit.route.drift', messageParams: { route: row.name } })
    service.engine.emit('event', { type: 'notification', event: 'route_drift', managedRouteId: row.id })
  }

  const update = (id: string, input: z.output<typeof ManagedRouteUpdateInput>, ctx: WriteContext) => queue(async () => {
    const row = find(id)
    validateExits([input.defaultEgressId, ...input.failover?.chain ?? []])
    let doc: WireRoute | undefined
    if (input.killSwitch !== undefined) {
      if (row.state === 'drift') throw new UnifiError('UNIFI_ROUTE_DRIFT')
      const run = runtime()
      const kill = input.killSwitch
      try {
        await run.writes.updateRoute(row.unifiRouteId, { kill_switch_enabled: kill }, ctx, (_before, after) => {
          doc = after
          set(id, { baselineFingerprint: routeFingerprint(after), routeShape: shape(after) })
        })
      } catch (error) {
        if (unifiErrorCode(error) === 'UNIFI_ROUTE_DRIFT') state(row, 'drift', 'route.state.drift')
        throw error
      }
      if (!run.active()) throw new UnifiError('UNIFI_INACTIVE')
    }
    const { name, enabled, defaultEgressId, failover } = input
    set(id, { name, enabled, defaultEgressId,
      ...(failover && { failover: FailoverPolicy.parse({ ...row.failover, ...failover }) }),
      ...(enabled !== undefined && row.state !== 'drift' && { state: enabled ? 'active' : 'paused', stateDetail: null }),
      ...(failover || defaultEgressId !== undefined ? clearFailover : {}) })
    if (Object.keys(input).length > 0) record({ ...row, name: name ?? row.name }, 'route.updated', ctx)
    changed(id)
    return get(id, doc)
  })

  const release = (id: string, deleteFromUnifi: boolean, ctx: WriteContext) => queue(async () => {
    const row = find(id)
    if (deleteFromUnifi) {
      if (!row.createdByUnifire) throw new UnifiError('ROUTE_NOT_OWNED')
      const run = runtime()
      const result = await run.writes.deleteRoute(row.unifiRouteId, ctx).catch(error => {
        if (unifiErrorCode(error) !== 'UNIFI_ROUTE_NOT_FOUND') throw error
        return { dryRun: service.status().mode === 'dry-run' || ctx.dryRun === true }
      })
      if (result.dryRun) return { ok: true as const }
      if (!run.active()) throw new UnifiError('UNIFI_INACTIVE')
    }
    db.delete(managedRoutes).where(eq(managedRoutes.id, id)).run()
    dryIntents.delete(id)
    record(row, 'route.released', ctx)
    changed(id)
    return { ok: true as const }
  })

  const schedule = (id: string, schedule: RouteScheduleT | null, ctx: WriteContext) => queue(() => {
    const row = find(id)
    if (schedule) {
      validateTimezone(schedule.timezone)
      validateExits([...schedule.grid.flat(), ...schedule.generator?.cycle ?? [], ...schedule.generator?.pinned.map(pin => pin.egressId) ?? []])
      db.insert(routeSchedules).values({ managedRouteId: id, ...schedule })
        .onConflictDoUpdate({ target: routeSchedules.managedRouteId, set: schedule }).run()
    } else db.delete(routeSchedules).where(eq(routeSchedules.managedRouteId, id)).run()
    record(row, 'route.scheduleChanged', ctx)
    changed(id)
    return get(id)
  })

  const override = (id: string, input: z.output<typeof OverrideInput> | null, ctx: WriteContext) => queue(() => {
    const row = find(id)
    const at = now()
    const endsAt = input?.endsAt ?? at + (input?.minutes ?? 0) * 60_000
    if (input && endsAt <= at) throw apiError(400, 'OVERRIDE_INVALID_END', 'errors.overrideInvalidEnd')
    if (input) validateExits([input.egressId])
    db.transaction(tx => {
      tx.delete(routeOverrides).where(and(eq(routeOverrides.managedRouteId, id), gt(routeOverrides.endsAt, at),
        ne(routeOverrides.createdBy, QUOTA_OVERRIDE_ACTOR))).run()
      if (input) tx.insert(routeOverrides).values({
        id: randomUUID(), managedRouteId: id, egressId: input.egressId, startsAt: at, endsAt, reason: input.reason ?? null,
        createdBy: `${ctx.actor.type}:${ctx.actor.id ?? 'system'}`,
      }).run()
    })
    record(row, input ? 'route.overrideSet' : 'route.overrideCleared', ctx)
    changed(id)
    return get(id)
  })

  const resume = (id: string, ctx: WriteContext) => queue(async () => {
    const row = find(id)
    const run = runtime()
    const doc = await fresh(run, row.unifiRouteId)
    if (classifyRoute(doc, service.ownership(run.config.site)) !== 'managed') throw new UnifiError('ROUTE_NOT_OWNED')
    set(id, { enabled: true, state: 'active', stateDetail: null, baselineFingerprint: routeFingerprint(doc),
      routeShape: shape(doc), ...clearFailover })
    record(row, 'route.resumed', ctx)
    changed(id)
    return get(id, doc)
  })

  function log(options: { managedRouteId?: string, cursor?: string, limit?: number } = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.trunc(options.limit!))) : 50
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor)
    const items = db.select().from(routeSwitchLog).where(and(
      options.managedRouteId ? eq(routeSwitchLog.managedRouteId, options.managedRouteId) : undefined,
      cursor ? or(lt(routeSwitchLog.ts, cursor[0]), and(eq(routeSwitchLog.ts, cursor[0]), lt(routeSwitchLog.id, cursor[1]))) : undefined,
    )).orderBy(desc(routeSwitchLog.ts), desc(routeSwitchLog.id)).limit(limit + 1).all()
    const last = items[limit - 1]
    return Paged(SwitchLogEntry).parse({ items: items.slice(0, limit),
      nextCursor: items.length > limit && last ? Buffer.from(JSON.stringify([last.ts, last.id])).toString('base64url') : null })
  }

  function upcoming(at: number) {
    return rows().filter(row => row.enabled && row.state !== 'drift').flatMap(row => {
      const time = timing(row, at)
      const output: UpcomingSwitchT[] = []
      let from: string | null = null
      for (const segment of previewSegments(time, at, at + 24 * HOUR + 1)) {
        if (segment.start > at && (from !== segment.egressId || segment.start === time.override?.endsAt)) {
          output.push({ at: segment.start, managedRouteId: row.id, routeName: row.name,
            fromEgressId: from, toEgressId: segment.egressId, reason: segment.reason })
        }
        from = segment.egressId
      }
      return output
    }).sort((a, b) => a.at - b.at || a.routeName.localeCompare(b.routeName)).slice(0, 10)
  }

  function switched(row: Row, from: string | null, to: string, reason: SwitchReasonT, result: {
    verified: boolean, dryRun: boolean, durationMs: number | null, error: string | null, diff?: AuditEventT['diff']
  }) {
    const ts = now()
    const entry = SwitchLogEntry.parse({ id: randomUUID(), ts, managedRouteId: row.id, routeName: row.name,
      fromEgressId: from, toEgressId: to, reason, ...result })
    db.transaction(tx => {
      tx.insert(routeSwitchLog).values(entry).run()
      if (entry.verified && !entry.dryRun) set(row.id, { lastSwitchAt: ts })
    })
    const labels = new Map(exits().map(exit => [exit.id, exit.name]))
    audit.record({
      actor: systemContext.actor, category: 'route', action: 'route.switched', severity: result.error ? 'error' : result.dryRun ? 'info' : 'success',
      target: { type: 'route', id: row.id, label: row.name }, messageKey: 'audit.route.switched', dryRun: result.dryRun, diff: result.diff,
      messageParams: { route: row.name, from: from ? labels.get(from) ?? from : '', to: labels.get(to) ?? to, reason },
    })
    if (entry.verified && !entry.dryRun && !entry.error) service.engine.emit('event', {
      type: 'notification', event: 'route_switch', managedRouteId: row.id, route: row.name,
      from: from ? labels.get(from) ?? from : '', to: labels.get(to) ?? to, reason,
    })
    liveBus.emit({ type: 'route.switched', data: entry })
    changed(row.id, false)
  }

  function reconcile() {
    return queue(async () => {
      const run = service.runtime
      if (!run?.active() || !service.status().connected) return
      const list = rows().filter(row => row.enabled && row.state !== 'drift')
      if (!list.length) return
      const docs = await run.api.routes()
      const actual = new Map(docs.map(doc => [doc._id, doc]))
      const readings = health()
      const enabled = new Set(exits().filter(exit => exit.enabled).map(exit => exit.id))
      const live = service.status().mode === 'live'
      if (live) dryIntents.clear()
      for (const row of list) {
        if (!run.active()) return
        const doc = actual.get(row.unifiRouteId)
        if (!doc) { state(row, 'error', 'route.state.missing'); continue }
        if (classifyRoute(doc, service.ownership(run.config.site)) !== 'managed') {
          state(row, 'error', 'errors.routeNotOwned'); continue
        }
        if (routeFingerprint(doc) !== row.baselineFingerprint) { state(row, 'drift', 'route.state.drift'); continue }
        const from = doc.network_id || null
        const at = now()
        const { desired, latch } = resolveEgress(timing(row, at), row.failover, row, readings, at, enabled, from)
        const to = desired.egressId
        if (!enabled.has(to)) { state(row, 'error', 'errors.egressNotFound'); continue }
        if (from === to) {
          set(row.id, latch)
          state(row, 'active', null)
          dryIntents.delete(row.id)
          continue
        }
        const reason = row.state === 'pending' && desired.reason === 'default' ? 'initial' : desired.reason
        const intent = JSON.stringify([from, to, reason])
        if (!live && dryIntents.get(row.id) === intent) continue
        try {
          const result = await run.writes.updateRouteEgress(row.unifiRouteId, to, { ...systemContext, quietSuccess: true })
          if (!run.active()) return
          if (result.dryRun) dryIntents.set(row.id, intent)
          if (!result.dryRun || reason !== 'recover') set(row.id, latch)
          state(row, 'active', null)
          if (result.changed) {
            if (!result.dryRun) {
              await run.cache.refresh('routes').catch(() => {})
              await run.cache.refresh('routes').catch(() => {})
            }
            if (!run.active()) return
            const egress = result.diff?.find(change => change.path === 'network_id')
            const before = egress ? egress.before : from
            const fromBeforeWrite = typeof before === 'string' && before ? before : null
            switched(row, fromBeforeWrite, to, reason, { ...result, error: null })
          }
        } catch (error) {
          if (!run.active()) return
          const code = unifiErrorCode(error)
          if (code === 'UNIFI_ROUTE_DRIFT') { state(row, 'drift', 'route.state.drift'); continue }
          const detail = code === 'UNIFI_ROUTE_NOT_FOUND' ? 'route.state.missing' : unifiStatusKey(code)
          state(row, 'error', detail)
          switched(row, from, to, reason, { verified: false, dryRun: !live, durationMs: null, error: detail })
        }
      }
    })
  }

  return {
    list: () => rows().map(row => get(row.id)), get, create, update, release, schedule, override, resume, log, reconcile,
    preview(id: string, hours: number) {
      const at = now()
      return RoutePreview.parse({ managedRouteId: id, segments: previewSegments(timing(find(id), at), at, at + hours * HOUR) })
    },
    dashboard(at: number) {
      const list = rows()
      return { routes: { managed: list.length, drift: list.filter(row => row.state === 'drift').length,
        overrides: list.filter(row => timing(row, at).override).length, unifiTotal: service.runtime?.cache.snapshot().routes.length ?? 0 },
      upcoming: upcoming(at), recentSwitches: log({ limit: 10 }).items }
    },
    timing(at = now()) {
      const timezone = settings.get().timezone
      return rows().map(row => {
        const time = timing(row, at)
        return { ...time, managedRouteId: row.id, enabled: row.enabled, timezone: time.schedule?.timezone ?? timezone }
      })
    },
  }
}
