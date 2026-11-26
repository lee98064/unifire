import { and, desc, eq, gte, lt, lte, or, sql, sum } from 'drizzle-orm'
import { Paged } from '#shared/schemas/common'
import { PortDetail, PortEvent, type PortEventQuery, type SeriesRangeT } from '#shared/schemas/infra'
import type { z } from 'zod'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Db } from '../../db'
import { personDevices, portDeltas, portEvents, portPeers, portRollups, portSamples } from '../../db/schema'
import { decodeCursor } from '../../services/audit'
import { UnifiError } from '../../unifi/errors'
import { DAY, HOUR, MINUTE } from '../access-time'

export type PortKey = { scope: string, switchMac: string, portIdx: number }
type PortColumns = Record<keyof PortKey, SQLiteColumn>
export const portKey = (table: PortColumns, key: PortKey) =>
  and(eq(table.scope, key.scope), eq(table.switchMac, key.switchMac), eq(table.portIdx, key.portIdx))!

export const PORT_BUCKET = 5 * MINUTE
export function samplePort(db: Pick<Db, 'insert'>, row: typeof portSamples.$inferInsert) {
  db.insert(portSamples).values(row).onConflictDoUpdate({
    target: [portSamples.scope, portSamples.switchMac, portSamples.portIdx, portSamples.ts],
    set: {
      observed: sql`observed + excluded.observed`, up: sql`up + excluded.up`, speed: row.speed,
      rx: add(portSamples.rx, 'rx'), rxCount: sql`rx_count + excluded.rx_count`,
      tx: add(portSamples.tx, 'tx'), txCount: sql`tx_count + excluded.tx_count`,
      errors: add(portSamples.errors, 'errors'), drops: add(portSamples.drops, 'drops'),
      poe: add(portSamples.poe, 'poe'), poeCount: sql`poe_count + excluded.poe_count`,
      onW: add(portSamples.onW, 'on_w'), onCount: sql`on_count + excluded.on_count`,
    },
  }).run()
}

function add(column: SQLiteColumn, excluded: 'rx' | 'tx' | 'errors' | 'drops' | 'poe' | 'on_w') {
  const incoming = sql.raw('excluded.' + excluded)
  return sql`case when ${column} is null then ${incoming} when ${incoming} is null then ${column} else ${column} + ${incoming} end`
}

export function archivePorts(db: Pick<Db, 'run' | 'delete'>, from: number, at: number,
  retention: { retainRawDays: number, retainRollupDays: number }) {
  const hour = Math.floor(at / HOUR) * HOUR
  db.run(sql`
    insert into port_rollups_hourly (scope, switch_mac, port_idx, ts, observed, up, speed,
      rx, rx_count, tx, tx_count, errors, drops, poe, poe_count, on_w, on_count)
    select scope, switch_mac, port_idx, hour, sum(observed), sum(up), max(case when newest = 1 then speed end),
      sum(rx), sum(rx_count), sum(tx), sum(tx_count), sum(errors), sum(drops), sum(poe), sum(poe_count), sum(on_w), sum(on_count)
    from (
      select *, (ts / ${HOUR}) * ${HOUR} as hour,
        row_number() over (partition by scope, switch_mac, port_idx, ts / ${HOUR} order by ts desc) as newest
      from port_samples where ts >= ${from} and ts < ${hour}
    ) group by scope, switch_mac, port_idx, hour
    on conflict(scope, switch_mac, port_idx, ts) do nothing
  `)
  // Keep enough five-minute data for the 24-hour drawer even at minimum retention.
  db.delete(portSamples).where(lt(portSamples.ts, at - retention.retainRawDays * DAY - PORT_BUCKET)).run()
  db.delete(portRollups).where(lt(portRollups.ts, hour - retention.retainRollupDays * DAY)).run()
  db.delete(portEvents).where(lt(portEvents.ts, at - 365 * DAY)).run()
}

export function averageOnW(db: Pick<Db, 'select'>, key: PortKey, at: number) {
  const from = Math.floor((at - 7 * DAY) / HOUR) * HOUR
  const hour = Math.floor(at / HOUR) * HOUR
  const aggregate = (table: typeof portSamples | typeof portRollups, start: number, before: number) =>
    db.select({ watts: sum(table.onW), samples: sum(table.onCount) }).from(table)
      .where(and(portKey(table, key), gte(table.ts, start), lt(table.ts, before))).get()
  const parts = [aggregate(portRollups, from, hour), aggregate(portSamples, hour, at + 1)]
  const samples = parts.reduce((total, part) => total + Number(part?.samples ?? 0), 0)
  return samples ? parts.reduce((total, part) => total + Number(part?.watts ?? 0), 0) / samples : null
}

export function recentDeltas(db: Pick<Db, 'select'>, key: PortKey, at: number) {
  const row = db.select({ errors: sum(portDeltas.errors), packets: sum(portDeltas.packets), flaps: sum(portDeltas.flaps) })
    .from(portDeltas).where(and(portKey(portDeltas, key), gte(portDeltas.ts, at - HOUR + 1), lte(portDeltas.ts, at))).get()
  const errors = Number(row?.errors ?? 0)
  const packets = Number(row?.packets ?? 0)
  return { errors, rate: packets > 0 ? errors / packets * 100 : null, flaps: Number(row?.flaps ?? 0) }
}

const Page = Paged(PortEvent)
function eventRows(db: Db, scope: string, query: Omit<z.output<typeof PortEventQuery>, 'limit'>, from?: number, to?: number) {
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
  return db.select().from(portEvents).where(and(eq(portEvents.scope, scope),
    query.switchMac === undefined ? undefined : eq(portEvents.switchMac, query.switchMac),
    query.portIdx === undefined ? undefined : eq(portEvents.portIdx, query.portIdx),
    query.unacknowledged === undefined ? undefined : eq(portEvents.acknowledged, !query.unacknowledged),
    from === undefined ? undefined : gte(portEvents.ts, from), to === undefined ? undefined : lte(portEvents.ts, to),
    cursor && or(lt(portEvents.ts, cursor[0]), and(eq(portEvents.ts, cursor[0]), lt(portEvents.id, cursor[1])))))
    .orderBy(desc(portEvents.ts), desc(portEvents.id))
}

export function listPortEvents(db: Db, scope: string, query: z.output<typeof PortEventQuery>, from?: number, to?: number) {
  const rows = eventRows(db, scope, query, from, to).limit(query.limit + 1).all()
  const last = rows[query.limit - 1]
  return Page.parse({ items: rows.slice(0, query.limit),
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify([last.ts, last.id])).toString('base64url') : null })
}

export function portEventHistory(db: Db, scope: string, switchMac: string, portIdx?: number, from?: number, to?: number, limit?: number) {
  const rows = eventRows(db, scope, { switchMac, portIdx }, from, to)
  return PortEvent.array().parse((limit === undefined ? rows : rows.limit(limit)).all())
}

export function updatePortEvent(db: Db, scope: string, id: string, acknowledged: boolean) {
  const row = db.update(portEvents).set({ acknowledged }).where(and(eq(portEvents.scope, scope), eq(portEvents.id, id))).returning().get()
  if (!row) throw new UnifiError('PORT_EVENT_NOT_FOUND', 404)
  return PortEvent.parse(row)
}

export function ackPortEvents(db: Db, scope: string, switchMac?: string) {
  const result = db.update(portEvents).set({ acknowledged: true }).where(and(eq(portEvents.scope, scope),
    eq(portEvents.acknowledged, false), switchMac === undefined ? undefined : eq(portEvents.switchMac, switchMac))).run()
  return { count: result.changes }
}

const ranges = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY }
export function portDetail(db: Db, key: PortKey, port: z.output<typeof PortDetail>['port'], range: SeriesRangeT, at: number) {
  const bucket = range === '24h' ? PORT_BUCKET : range === '7d' ? HOUR : 6 * HOUR
  const from = Math.floor((at - ranges[range]) / bucket) * bucket
  const hour = Math.floor(at / HOUR) * HOUR
  const raw = db.select().from(portSamples).where(and(portKey(portSamples, key),
    gte(portSamples.ts, range === '24h' ? from : hour), lte(portSamples.ts, at))).orderBy(portSamples.ts).all()
  const hourly = range === '24h' ? [] : db.select().from(portRollups).where(and(portKey(portRollups, key),
    gte(portRollups.ts, from), lt(portRollups.ts, hour))).orderBy(portRollups.ts).all()
  const groups = new Map<number, typeof raw>()
  for (const row of [...hourly, ...raw]) {
    const ts = Math.floor(row.ts / bucket) * bucket
    const group = groups.get(ts) ?? []
    group.push(row)
    groups.set(ts, group)
  }
  const series = [...groups].map(([ts, rows]) => {
    const add = (key: 'observed' | 'up' | 'rx' | 'rxCount' | 'tx' | 'txCount' | 'poe' | 'poeCount' | 'errors' | 'drops') => {
      const numbers = rows.flatMap(row => row[key] ?? [])
      return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null
    }
    const mean = (key: 'rx' | 'tx' | 'poe') => {
      const count = add(`${key}Count`)
      return count ? (add(key) ?? 0) / count : null
    }
    return { ts, up: add('up')! / add('observed')!, speedMbps: rows.at(-1)!.speed,
      rxBps: mean('rx'), txBps: mean('tx'), errors: add('errors'), drops: add('drops'), poeW: mean('poe') }
  })
  const peers = db.select({ mac: portPeers.mac, name: portPeers.name, personId: personDevices.personId,
    firstSeen: portPeers.firstSeen, lastSeen: portPeers.lastSeen, maxSpeedMbps: portPeers.maxSpeed })
    .from(portPeers).leftJoin(personDevices, eq(personDevices.mac, portPeers.mac))
    .where(portKey(portPeers, key)).orderBy(desc(portPeers.lastSeen), portPeers.mac).all()
  const events = portEventHistory(db, key.scope, key.switchMac, key.portIdx, at - ranges[range], at)
  return PortDetail.parse({ port, peers, events, range, bucketSec: bucket / 1000, series })
}
