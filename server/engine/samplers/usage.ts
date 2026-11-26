import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { ClientUsageT } from '#shared/schemas/access'
import type { Db } from '../../db'
import { settings, usageDaily, usageHourly, usageMinutes, usageQuarters } from '../../db/schema'
import type { WireStation } from '../../unifi/endpoints/schemas'
import { DAY, HOUR, MINUTE, localDate, zonedInstant } from '../access-time'

const QUARTER = 15 * MINUTE
const ZERO = { rxBytes: 0, txBytes: 0, activeMinutes: 0 }
const dayKey = 'usage.rollupTimezone'
const bucket = (at: number, size: number) => Math.floor(at / size) * size
type MinuteRow = typeof usageMinutes.$inferInsert
type Totals = typeof ZERO

function addTotals(total: Totals, other: Totals) {
  total.rxBytes += other.rxBytes
  total.txBytes += other.txBytes
  total.activeMinutes += other.activeMinutes
}

export function countBits(mask: number) {
  let count = 0
  for (; mask; mask &= mask - 1) count++
  return count
}

export function counterDelta(previous: number, current: number) {
  return current < previous ? current : current - previous
}

export function createUsageSampler() {
  let previousAt: number | undefined
  let previous = new Map<string, { rx: number, tx: number }>()
  return (stations: WireStation[], at: number, threshold: number): MinuteRow[] => {
    const next = new Map<string, { rx: number, tx: number }>()
    const rows: MinuteRow[] = []
    const interval = previousAt === undefined ? 0 : at - previousAt
    if (previousAt !== undefined && bucket(previousAt, MINUTE) >= bucket(at, MINUTE)) return rows
    for (const station of stations) {
      const { rx_bytes: rx, tx_bytes: tx } = station
      if (rx == null || tx == null || !Number.isSafeInteger(rx) || !Number.isSafeInteger(tx) || rx < 0 || tx < 0) continue
      next.set(station.mac, { rx, tx })
      const last = previous.get(station.mac)
      if (!last || interval <= 0 || interval >= 2 * MINUTE || bucket(at, MINUTE) - bucket(previousAt!, MINUTE) !== MINUTE) continue
      const rxBytes = counterDelta(last.rx, rx)
      const txBytes = counterDelta(last.tx, tx)
      if (rxBytes + txBytes > 10_000_000_000 / 8 * (interval / 1000)) continue
      rows.push({ mac: station.mac, ts: bucket(at, MINUTE) - MINUTE, rxBytes, txBytes, active: rxBytes + txBytes >= threshold })
    }
    previous = next
    previousAt = at
    return rows
  }
}

function dayResolver(timezone: string) {
  const starts = new Map<number, number>()
  return (at: number) => {
    const day = localDate(at, timezone)
    const start = starts.get(day) ?? zonedInstant(day, timezone)
    starts.set(day, start)
    return start
  }
}

export function createUsageStore(db: Db) {
  function ensureDaily(timezone: string) {
    if (db.select().from(settings).where(eq(settings.key, dayKey)).get()?.value === timezone) return
    const dayStart = dayResolver(timezone)
    db.transaction(tx => {
      const totals = new Map<string, typeof usageDaily.$inferInsert>()
      const daysByQuarter = new Map<number, number>()
      for (const row of tx.select().from(usageQuarters).all()) {
        const ts = daysByQuarter.get(row.ts) ?? dayStart(row.ts)
        daysByQuarter.set(row.ts, ts)
        const key = `${row.mac}:${ts}`
        const total = totals.get(key) ?? { ...ZERO, mac: row.mac, ts }
        addTotals(total, { ...row, activeMinutes: countBits(row.activeMask) })
        totals.set(key, total)
      }
      tx.delete(usageDaily).run()
      for (const row of totals.values()) tx.insert(usageDaily).values(row).run()
      tx.insert(settings).values({ key: dayKey, value: timezone }).onConflictDoUpdate({
        target: settings.key, set: { value: timezone },
      }).run()
    })
  }

  function record(rows: MinuteRow[], timezone: string) {
    ensureDaily(timezone)
    const dayStart = dayResolver(timezone)
    const dayCache = new Map<number, number>()
    db.transaction(tx => {
      const addHour = tx.insert(usageHourly).values({
        mac: sql.placeholder('mac'), ts: sql.placeholder('ts'), rxBytes: sql.placeholder('rxBytes'),
        txBytes: sql.placeholder('txBytes'), activeMinutes: sql.placeholder('activeMinutes'),
      }).onConflictDoUpdate({ target: [usageHourly.mac, usageHourly.ts], set: {
        rxBytes: sql`rx_bytes + excluded.rx_bytes`, txBytes: sql`tx_bytes + excluded.tx_bytes`,
        activeMinutes: sql`active_minutes + excluded.active_minutes`,
      } }).prepare()
      const addDay = tx.insert(usageDaily).values({
        mac: sql.placeholder('mac'), ts: sql.placeholder('ts'), rxBytes: sql.placeholder('rxBytes'),
        txBytes: sql.placeholder('txBytes'), activeMinutes: sql.placeholder('activeMinutes'),
      }).onConflictDoUpdate({ target: [usageDaily.mac, usageDaily.ts], set: {
        rxBytes: sql`rx_bytes + excluded.rx_bytes`, txBytes: sql`tx_bytes + excluded.tx_bytes`,
        activeMinutes: sql`active_minutes + excluded.active_minutes`,
      } }).prepare()
      const insertMinute = tx.insert(usageMinutes).values({
        mac: sql.placeholder('mac'), ts: sql.placeholder('ts'), rxBytes: sql.placeholder('rxBytes'),
        txBytes: sql.placeholder('txBytes'), active: sql.placeholder('active'),
      }).onConflictDoNothing().prepare()
      const addQuarter = tx.insert(usageQuarters).values({
        mac: sql.placeholder('mac'), ts: sql.placeholder('ts'), rxBytes: sql.placeholder('rxBytes'),
        txBytes: sql.placeholder('txBytes'), activeMask: sql.placeholder('activeMask'), sampleMask: sql.placeholder('sampleMask'),
      }).onConflictDoUpdate({ target: [usageQuarters.mac, usageQuarters.ts], set: {
        rxBytes: sql`rx_bytes + excluded.rx_bytes`, txBytes: sql`tx_bytes + excluded.tx_bytes`,
        activeMask: sql`active_mask | excluded.active_mask`, sampleMask: sql`sample_mask | excluded.sample_mask`,
      }, setWhere: sql`(sample_mask & excluded.sample_mask) = 0` }).prepare()
      for (const row of rows) {
        const ts = bucket(row.ts, QUARTER)
        const sampleMask = 1 << ((row.ts - ts) / MINUTE)
        if (!addQuarter.run({ ...row, ts, sampleMask, activeMask: row.active ? sampleMask : 0 }).changes) continue
        insertMinute.run(row)
        const day = dayCache.get(ts) ?? dayStart(ts)
        dayCache.set(ts, day)
        const totals = { ...row, activeMinutes: Number(row.active) }
        addHour.run({ ...totals, ts: bucket(row.ts, HOUR) })
        addDay.run({ ...totals, ts: day })
      }
    })
  }

  function forMacs(macs: string[], start: number, end: number) {
    if (!macs.length) return { ...ZERO }
    const used = { ...ZERO }
    const activity = new Map<number, number>()
    for (const row of db.select().from(usageQuarters).where(and(
      inArray(usageQuarters.mac, macs), gte(usageQuarters.ts, start), lt(usageQuarters.ts, end),
    )).all()) {
      used.rxBytes += row.rxBytes
      used.txBytes += row.txBytes
      activity.set(row.ts, (activity.get(row.ts) ?? 0) | row.activeMask)
    }
    for (const mask of activity.values()) used.activeMinutes += countBits(mask)
    return used
  }

  function history(mac: string, range: ClientUsageT['range'], at: number, timezone: string): ClientUsageT {
    const hourly = range === '24h'
    if (!hourly) ensureDaily(timezone)
    const days = range === '30d' ? 30 : 7
    const date = localDate(at, timezone)
    const starts = hourly
      ? Array.from({ length: 24 }, (_, index) => bucket(at, HOUR) - (23 - index) * HOUR)
      : Array.from({ length: days }, (_, index) => zonedInstant(date - (days - 1 - index) * DAY, timezone))
    const table = hourly ? usageHourly : usageDaily
    const rows = new Map(db.select().from(table).where(and(eq(table.mac, mac), gte(table.ts, starts[0]!), lt(table.ts, at + 1)))
      .all().map(row => [row.ts, row]))
    const totals = { ...ZERO }
    const buckets = starts.map(ts => {
      const { rxBytes, txBytes, activeMinutes } = rows.get(ts) ?? ZERO
      const row = { ts, rxBytes, txBytes, activeMinutes }
      addTotals(totals, row)
      return row
    })
    return { mac, range, buckets, totals }
  }

  return {
    record, forMacs, history,
    today(at: number, timezone: string) {
      ensureDaily(timezone)
      const ts = dayResolver(timezone)(at)
      return new Map(db.select().from(usageDaily).where(eq(usageDaily.ts, ts)).all().map(row => [
        row.mac, { activeMinutes: row.activeMinutes, bytes: row.rxBytes + row.txBytes },
      ]))
    },
    prune(at: number, days: number) {
      db.delete(usageMinutes).where(lt(usageMinutes.ts, bucket(at - days * DAY, MINUTE))).run()
    },
  }
}
