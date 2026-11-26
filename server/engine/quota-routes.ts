import { and, eq } from 'drizzle-orm'
import type { PersonT } from '#shared/schemas/access'
import type { Db } from '../db'
import { managedRoutes, quotaRoutes, routeOverrides } from '../db/schema'
import { createAuditService } from '../services/audit'
import { systemContext, type ControllerService } from '../services/controller'
import { classifyRoute, QUOTA_PREFIX, routeFingerprint } from '../services/ownership'
import type { QuotaEvaluation } from '../services/quotas'
import type { WireRoute } from '../unifi/endpoints/schemas'
import { UnifiError } from '../unifi/errors'
import { liveBus } from '../utils/bus'
import { QUOTA_OVERRIDE_ACTOR } from './managed-routes'

export function createQuotaRoutes(db: Db, service: ControllerService, now = Date.now) {
  const audit = createAuditService(db)
  let warned = new Set<string>()
  const previews = new Map<string, string>()

  return async (evaluations: QuotaEvaluation[], people: PersonT[]) => {
    const runtime = service.runtime
    if (!runtime?.active() || !service.status().connected) return
    const at = now()
    const scope = eq(quotaRoutes.controllerScope, runtime.scope)
    const owned = db.select().from(quotaRoutes).where(scope).all()
    const inventory = runtime.cache.snapshot()
    const present = new Set([...inventory.knownClients, ...inventory.activeClients].map(row => row.mac))
    const exits = new Set(inventory.networks.filter(row => row.enabled !== false
      && (row.purpose === 'wan' || row.purpose === 'vpn-client')).map(row => row._id))
    const persons = new Map(people.map(person => [person.id, person]))
    const desired = new Map<string, { name: string, egress: string, macs: string[], until: number }>()
    for (const { quota, status, personId, subject, macs } of [...evaluations].sort((a, b) => a.quota.id.localeCompare(b.quota.id))) {
      if (!quota.enabled || quota.action.type !== 'egress' || status.state !== 'exceeded' || status.resetsAt <= at
        || !exits.has(quota.action.egressId) || desired.has(subject)) continue
      const person = personId ? persons.get(personId) : undefined
      const targets = (person?.deviceMacs ?? macs).filter(mac => present.has(mac)).sort()
      if (targets.length) desired.set(subject, { name: person?.name ?? targets[0]!, egress: quota.action.egressId, macs: targets, until: status.resetsAt })
    }
    const ownership = () => service.ownership(runtime.config.site)
    const ownershipIds = new Set([...ownership().managed.values()].map(route => route.id))
    const before = db.select({ override: routeOverrides }).from(routeOverrides)
      .innerJoin(managedRoutes, eq(managedRoutes.id, routeOverrides.managedRouteId))
      .where(and(eq(routeOverrides.createdBy, QUOTA_OVERRIDE_ACTOR), eq(managedRoutes.site, runtime.config.site))).all()
      .flatMap(({ override }) => ownershipIds.has(override.managedRouteId) ? [override] : [])
    if (!desired.size && !owned.length && !before.length) { warned.clear(); return }
    const actual = new Map((await runtime.api.routes()).map(row => [row._id, row]))
    const bySubject = new Map(owned.map(row => [row.subject, row]))
    const live = service.status().mode === 'live'
    const matching = (docs: Iterable<WireRoute>, macs: Set<string>) => {
      const owners = ownership()
      return [...docs].flatMap(doc => {
        const route = owners.managed.get(doc._id)
        if (!route || classifyRoute(doc, owners) !== 'managed') return []
        const targets = doc.target_devices.filter(device => String(device.type).toUpperCase() === 'CLIENT'
          && typeof device.client_mac === 'string' && macs.has(device.client_mac.toLowerCase()))
          .map(device => String(device.client_mac).toLowerCase())
        return targets.length ? [{ route, targets }] : []
      })
    }
    const overrides = new Map<string, { egress: string, until: number }>()
    const warnings = new Set<string>()
    for (const [subject, intent] of desired) {
      const remaining = new Set(intent.macs)
      for (const { route, targets } of matching(actual.values(), remaining)) {
        for (const mac of targets) remaining.delete(mac)
        const key = JSON.stringify([runtime.scope, subject, route.id, intent.egress, intent.until, live])
        warnings.add(key)
        if (!warned.has(key)) audit.record({ actor: systemContext.actor, category: 'quota', action: 'quota.routeOverlap',
          target: { type: 'route', id: route.id, label: route.name }, severity: 'warning', dryRun: !live,
          messageKey: 'audit.quota.routeOverlap', messageParams: { person: intent.name, route: route.name } })
        if (!overrides.has(route.id)) overrides.set(route.id, intent)
      }
      intent.macs = [...remaining]
    }
    warned = warnings
    if (live) previews.clear()
    for (const subject of new Set([...desired.keys(), ...bySubject.keys()])) {
      if (!runtime.active()) return
      const intent = desired.get(subject)
      const row = bySubject.get(subject)
      const current = row && actual.get(row.routeId)
      const key = and(scope, eq(quotaRoutes.subject, subject))
      const forward = intent?.macs.length ? {
        enabled: true, description: `${QUOTA_PREFIX} ${intent.name}`, network_id: intent.egress,
        target_devices: intent.macs.map(mac => ({ type: 'CLIENT', client_mac: mac })),
      } : undefined
      const patch = forward ?? { enabled: false }
      const draft = forward && {
        ...forward, matching_target: 'INTERNET', next_hop: '', kill_switch_enabled: false,
        domains: [], ip_addresses: [], ip_ranges: [], regions: [],
      }
      if (!draft && !current?.enabled) {
        if (row && !current) db.delete(quotaRoutes).where(key).run()
        continue
      }
      if (current && Object.entries(patch).every(([field, value]) => JSON.stringify(value) === JSON.stringify(current[field]))) continue
      const marker = JSON.stringify([current ?? null, patch])
      const previewKey = `${runtime.scope}:${subject}`
      if (!live && previews.get(previewKey) === marker) continue
      const checkOverlap = draft ? (docs: WireRoute[]) => {
        if (matching(docs, new Set(intent!.macs)).length) throw new UnifiError('UNIFI_QUOTA_ROUTE_CONFLICT')
      } : undefined
      try {
        const result = current
          ? await runtime.writes.updateRoute(current._id, patch, systemContext, (_before, after) => {
            db.update(quotaRoutes).set({ fingerprint: routeFingerprint(after) }).where(key).run()
          }, checkOverlap)
          : draft && await runtime.writes.createRoute(draft, systemContext, {
            checkExisting(docs) {
              checkOverlap?.(docs)
              const knownIds = service.ownership(runtime.config.site).quotaRoutes
              const macs = new Set(draft.target_devices.map(device => device.client_mac))
              // A lost POST response can leave an unowned route. Never adopt or duplicate it.
              if (docs.some(doc => !knownIds.has(doc._id) && doc.description === draft.description
                && doc.target_devices.some(device => typeof device.client_mac === 'string' && macs.has(device.client_mac)))) {
                throw new UnifiError('UNIFI_QUOTA_ROUTE_CONFLICT')
              }
            },
            created(id) {
              const fingerprint = routeFingerprint({ ...draft, _id: id })
              db.insert(quotaRoutes).values({ controllerScope: runtime.scope, subject, routeId: id, fingerprint })
                .onConflictDoUpdate({ target: [quotaRoutes.controllerScope, quotaRoutes.subject], set: { routeId: id, fingerprint } }).run()
            },
          })
        if (result?.dryRun) previews.set(previewKey, marker)
      } catch { /* The gate records each error. Reconcile again during the next pass. */ }
    }

    if (!live || !runtime.active() || service.status().mode !== 'live') return
    const changed = db.transaction(tx => {
      const changes = new Set<string>()
      for (const row of before) {
        if (overrides.has(row.managedRouteId)) continue
        tx.delete(routeOverrides).where(eq(routeOverrides.id, row.id)).run()
        changes.add(row.managedRouteId)
      }
      const current = new Map(before.map(row => [row.managedRouteId, row]))
      for (const [id, intent] of overrides) {
        if (!tx.select({ id: managedRoutes.id }).from(managedRoutes).where(eq(managedRoutes.id, id)).get()) continue
        const old = current.get(id)
        if (old?.egressId === intent.egress && old.endsAt === intent.until) continue
        const values = { startsAt: at, endsAt: intent.until, egressId: intent.egress }
        tx.insert(routeOverrides).values({ id: `quota:${id}`, managedRouteId: id, ...values,
          reason: 'rule', createdBy: QUOTA_OVERRIDE_ACTOR }).onConflictDoUpdate({ target: routeOverrides.id, set: values }).run()
        changes.add(id)
      }
      return changes
    })
    for (const id of changed) {
      service.engine.emit('event', { type: 'routing.changed', managedRouteId: id })
      liveBus.emit({ type: 'route.changed', data: { managedRouteId: id } })
    }
  }
}
