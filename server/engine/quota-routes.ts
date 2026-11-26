import { and, eq } from 'drizzle-orm'
import type { PersonT } from '#shared/schemas/access'
import type { Db } from '../db'
import { quotaRoutes } from '../db/schema'
import { systemContext, type ControllerService } from '../services/controller'
import { QUOTA_PREFIX, routeFingerprint } from '../services/ownership'
import type { QuotaEvaluation } from '../services/quotas'
import { UnifiError } from '../unifi/errors'

export function createQuotaRoutes(db: Db, service: ControllerService) {
  const previews = new Map<string, string>()

  return async (evaluations: QuotaEvaluation[], people: PersonT[]) => {
    const runtime = service.runtime
    if (!runtime?.active() || !service.status().connected) return
    const scope = eq(quotaRoutes.controllerScope, runtime.scope)
    const owned = db.select().from(quotaRoutes).where(scope).all()
    const inventory = runtime.cache.snapshot()
    const present = new Set([...inventory.knownClients, ...inventory.activeClients].map(row => row.mac))
    const exits = new Set(inventory.networks.filter(row => row.enabled !== false
      && (row.purpose === 'wan' || row.purpose === 'vpn-client')).map(row => row._id))
    const persons = new Map(people.map(person => [person.id, person]))
    const desired = new Map<string, { name: string, egress: string, macs: string[] }>()
    for (const { quota, status, personId, subject, macs } of [...evaluations].sort((a, b) => a.quota.id.localeCompare(b.quota.id))) {
      if (!quota.enabled || quota.action.type !== 'egress' || status.state !== 'exceeded'
        || !exits.has(quota.action.egressId) || desired.has(subject)) continue
      const person = personId ? persons.get(personId) : undefined
      const targets = (person?.deviceMacs ?? macs).filter(mac => present.has(mac)).sort()
      if (targets.length) desired.set(subject, { name: person?.name ?? targets[0]!, egress: quota.action.egressId, macs: targets })
    }
    if (!desired.size && !owned.length) return
    const actual = new Map((await runtime.api.routes()).map(row => [row._id, row]))
    const bySubject = new Map(owned.map(row => [row.subject, row]))
    const live = service.status().mode === 'live'
    if (live) previews.clear()
    for (const subject of new Set([...desired.keys(), ...bySubject.keys()])) {
      if (!runtime.active()) return
      const intent = desired.get(subject)
      const row = bySubject.get(subject)
      const current = row && actual.get(row.routeId)
      const key = and(scope, eq(quotaRoutes.subject, subject))
      const forward = intent ? {
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
      try {
        const result = current
          ? await runtime.writes.updateRoute(current._id, patch, systemContext, (_before, after) => {
            db.update(quotaRoutes).set({ fingerprint: routeFingerprint(after) }).where(key).run()
          })
          : draft && await runtime.writes.createRoute(draft, systemContext, {
            checkExisting(docs) {
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
  }
}
