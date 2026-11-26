import { and, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { routeExternalChanges, routeObservations } from '../db/schema'
import type { WireRoute } from '../unifi/endpoints/schemas'
import { documentFingerprint } from './ownership'

const DAY = 86_400_000
const WRITE_WINDOW = 15_000

export function createRouteObservations(db: Db, scope: string) {
  const writes = new Map<string, { ts: number, fingerprint: string }[]>()

  function recordWrite(route: WireRoute, ts = Date.now()) {
    const recent = (writes.get(route._id) ?? []).filter(write => ts - write.ts <= WRITE_WINDOW)
    writes.set(route._id, [...recent, { ts, fingerprint: documentFingerprint(route) }])
  }

  function observe(routes: WireRoute[], ts = Date.now(), observedAt = ts) {
    for (const [id, entries] of writes) {
      if (entries.every(entry => observedAt - entry.ts > WRITE_WINDOW)) writes.delete(id)
    }
    db.transaction(tx => {
      const before = new Map(tx.select().from(routeObservations)
        .where(eq(routeObservations.scope, scope)).all().map(row => [row.routeId, row]))
      for (const route of routes) {
        const previous = before.get(route._id)
        before.delete(route._id)
        const fingerprint = documentFingerprint(route)
        if (previous?.fingerprint === fingerprint) continue
        const egressId = route.network_id || null
        const own = writes.get(route._id)?.some(write =>
          Math.abs(observedAt - write.ts) <= WRITE_WINDOW && write.fingerprint === fingerprint)
        if (previous && !own) {
          tx.insert(routeExternalChanges).values({
            scope, routeId: route._id, ts, egressChanged: previous.egressId !== egressId,
          }).onConflictDoNothing().run()
        }
        const observation = { fingerprint, egressId }
        tx.insert(routeObservations).values({ scope, routeId: route._id, ...observation })
          .onConflictDoUpdate({ target: [routeObservations.scope, routeObservations.routeId], set: observation }).run()
      }
      for (const { routeId } of before.values()) {
        tx.delete(routeObservations).where(and(eq(routeObservations.scope, scope), eq(routeObservations.routeId, routeId))).run()
      }
      tx.delete(routeExternalChanges).where(and(lt(routeExternalChanges.ts, ts - 2 * DAY), sql`
        EXISTS (SELECT 1 FROM route_external_changes newer
          WHERE newer.scope = ${routeExternalChanges.scope} AND newer.route_id = ${routeExternalChanges.routeId}
          AND newer.ts > ${routeExternalChanges.ts})
      `)).run()
    })
  }

  function details(routeId: string, now = Date.now()) {
    const changes = db.select().from(routeExternalChanges)
      .where(and(eq(routeExternalChanges.scope, scope), eq(routeExternalChanges.routeId, routeId))).all()
    return {
      lastExternalChangeAt: changes.reduce<number | null>((latest, row) => Math.max(latest ?? 0, row.ts), null),
      suspectedAutomation: changes.filter(row => row.egressChanged && row.ts >= now - DAY).length >= 3,
    }
  }

  return { recordWrite, observe, details }
}
