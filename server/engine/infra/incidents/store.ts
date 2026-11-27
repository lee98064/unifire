import { and, asc, count, desc, eq, gte, gt, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { Id, Paged, Ts } from '#shared/schemas/common'
import { Incident, IncidentDetail, type IncidentQueryT, type IncidentT, type IncidentUpdateInputT } from '#shared/schemas/infra'
import type { Db } from '../../../db'
import { incidents, incidentSignals, incidentWanState, snapshots } from '../../../db/schema'
import { apiError } from '../../../utils/api-error'
import { DAY } from '../../access-time'
import { incidentToJoin, isSuspect, recoveryState, resolutionAt, summarize, suspectWindow, type Signal } from './correlate'
import { randomUUID } from 'node:crypto'

const page = Paged(Incident)
const cursor = z.tuple([z.enum(['open', 'resolved']), Ts, Id])
const sortStatus = sql`case when ${incidents.status} = 'open' then 0 else 1 end`
const signalOrder = sql`incident_signals.rowid`

export function openIncidentCount(db: Db, scope: string | undefined) {
  if (!scope) return 0
  return db.select({ total: count() }).from(incidents)
    .where(and(eq(incidents.scope, scope), eq(incidents.status, 'open'))).get()?.total ?? 0
}

export function dashboardIncidents(db: Db, scope: string | undefined) {
  if (!scope) return []
  return Incident.array().parse(db.select().from(incidents)
    .where(and(eq(incidents.scope, scope), eq(incidents.status, 'open')))
    .orderBy(sql`case when ${incidents.severity} = 'critical' then 0 else 1 end`, desc(incidents.openedAt), desc(incidents.id))
    .limit(3).all())
}

export function createIncidentStore(db: Db, scope: string) {
  const scoped = eq(incidents.scope, scope)
  const scopedSignal = eq(incidentSignals.scope, scope)
  const find = (id: string) => and(scoped, eq(incidents.id, id))
  const readSignals = (id: string) => db.select().from(incidentSignals).where(eq(incidentSignals.incidentId, id))
    .orderBy(asc(incidentSignals.ts), signalOrder).all()
  const open = () => db.select().from(incidents).where(and(scoped, eq(incidents.status, 'open')))
    .orderBy(desc(incidents.openedAt), desc(incidents.id)).all()
    .map(row => ({ row, latestAt: row.latestAt, signals: readSignals(row.id) }))

  function list(query: IncidentQueryT) {
    let after
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 512 || !/^[\da-z_-]+$/i.test(query.cursor)) throw new Error('Invalid cursor')
        const [status, ts, id] = cursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')))
        after = or(status === 'open' ? eq(incidents.status, 'resolved') : undefined,
          and(eq(incidents.status, status), or(lt(incidents.openedAt, ts), and(eq(incidents.openedAt, ts), lt(incidents.id, id)))))
      } catch {
        throw apiError(400, 'INVALID_CURSOR', 'errors.invalidCursor')
      }
    }
    const rows = db.select().from(incidents).where(and(scoped, query.status ? eq(incidents.status, query.status) : undefined, after))
      .orderBy(sortStatus, desc(incidents.openedAt), desc(incidents.id)).limit(query.limit + 1).all()
    const items = rows.slice(0, query.limit)
    const last = items.at(-1)
    return page.parse({ items, nextCursor: rows.length > query.limit && last
      ? Buffer.from(JSON.stringify([last.status, last.openedAt, last.id])).toString('base64url') : null })
  }

  const notFound = () => apiError(404, 'INCIDENT_NOT_FOUND', 'errors.incidentNotFound')
  function detail(id: string) {
    const row = db.select().from(incidents).where(find(id)).get()
    if (!row) throw notFound()
    const signals = readSignals(id)
    const earliest = signals.find(signal => signal.suspect)
    let diff: z.output<typeof IncidentDetail>['diff'] = null
    if (earliest) {
      const withinScope = eq(snapshots.controllerScope, scope)
      const before = db.select({ id: snapshots.id }).from(snapshots)
        .where(and(withinScope, lt(snapshots.ts, earliest.ts))).orderBy(desc(snapshots.ts), desc(snapshots.id)).get()
      if (before) {
        const after = db.select({ id: snapshots.id }).from(snapshots)
          .where(and(withinScope, gt(snapshots.ts, earliest.ts))).orderBy(asc(snapshots.ts), asc(snapshots.id)).get()
        diff = { fromSnapshotId: before.id, toSnapshotId: after?.id ?? null }
      }
    }
    return IncidentDetail.parse({ ...row, signals, diff })
  }

  function update(id: string, patch: IncidentUpdateInputT) {
    if (patch.note === undefined && patch.acknowledged === undefined) return Incident.parse(detail(id))
    const saved = db.update(incidents).set(patch).where(find(id)).returning().get()
    if (!saved) throw notFound()
    return Incident.parse(saved)
  }

  function persist(signal: Signal, baselineClients: number, windowMinutes: number) {
    return db.transaction(tx => {
      if ((signal.kind === 'wan_up' || signal.kind === 'wan_down') && signal.ref) {
        const up = signal.kind === 'wan_up'
        tx.insert(incidentWanState).values({ scope, egressId: signal.ref.id, up }).onConflictDoUpdate({
          target: [incidentWanState.scope, incidentWanState.egressId], set: { up },
        }).run()
      }
      const changes: { incident: IncidentT, event: 'opened' | 'escalated' | 'changed' }[] = []
      const candidates = open()
      const { facts } = signal
      const append = (entry: (typeof candidates)[number], added: Signal) => {
        tx.insert(incidentSignals).values({ ...added, scope, incidentId: entry.row.id }).run()
        const signals = readSignals(entry.row.id)
        const summary = summarize(signals, entry.row.baselineClients, entry.row.severity)
        const latestAt = Math.max(entry.latestAt, added.ts)
        tx.update(incidents).set({ ...summary, latestAt }).where(find(entry.row.id)).run()
        changes.push({ incident: Incident.parse({ ...entry.row, ...summary }),
          event: summary.severity !== entry.row.severity ? 'escalated' : 'changed' })
      }
      if (signal.kind === 'config_change') {
        tx.insert(incidentSignals).values({ ...signal, scope }).run()
        for (const entry of candidates) {
          if (isSuspect(signal, entry.row.openedAt)) {
            append(entry, { ...signal, id: randomUUID(), suspect: true })
          }
        }
      } else if (facts.recovers) {
        for (const entry of candidates) {
          const existing = recoveryState(entry.signals).pending
          if (facts.recovers.some(key => existing.has(key))) append(entry, { ...signal, id: randomUUID() })
        }
        if (!changes.length) tx.insert(incidentSignals).values({ ...signal, scope }).run()
      } else {
        const matching = incidentToJoin(signal, candidates, windowMinutes)
        if (matching) append(matching, signal)
        else if (facts.failure) {
          const before = tx.select().from(incidentSignals).where(and(scopedSignal, isNull(incidentSignals.incidentId),
            eq(incidentSignals.kind, 'config_change'), gte(incidentSignals.ts, signal.ts - suspectWindow), lte(incidentSignals.ts, signal.ts)))
            .orderBy(asc(incidentSignals.ts), signalOrder).all()
          const initial = before.map(item => ({ ...item, id: randomUUID(), suspect: true }))
          const summary = summarize([...initial, signal], baselineClients, 'warning')
          const row = { ...summary, id: randomUUID(), scope, status: 'open' as const,
            openedAt: signal.ts, latestAt: signal.ts, resolvedAt: null, baselineClients }
          const saved = tx.insert(incidents).values(row).returning().get()!
          tx.insert(incidentSignals).values([...initial, signal].map(item => ({ ...item, scope, incidentId: row.id }))).run()
          changes.push({ incident: Incident.parse(saved), event: 'opened' })
        } else tx.insert(incidentSignals).values({ ...signal, scope }).run()
      }
      return changes
    })
  }

  function extendMass(signal: Signal, clients: string[]) {
    const count = String(clients.length)
    db.update(incidentSignals).set({ facts: { ...signal.facts, lostClients: clients },
      messageParams: { ...signal.messageParams, count } }).where(and(scopedSignal, eq(incidentSignals.id, signal.id))).run()
  }

  function settle(quietMinutes: number, at: number) {
    return db.transaction(tx => open().flatMap(({ row, signals }) => {
      const resolvedAt = resolutionAt(signals, quietMinutes, at)
      if (resolvedAt === null) return []
      const saved = tx.update(incidents).set({ resolvedAt, status: 'resolved' }).where(find(row.id)).returning().get()
      return saved ? [Incident.parse(saved)] : []
    }))
  }

  function prune(at: number) {
    const cutoff = at - 365 * DAY
    db.transaction(tx => {
      tx.delete(incidents).where(lt(incidents.openedAt, cutoff)).run()
      tx.delete(incidentSignals).where(and(isNull(incidentSignals.incidentId), lt(incidentSignals.ts, cutoff))).run()
    })
  }

  return { list, detail, update, persist, open, extendMass, settle, prune }
}

