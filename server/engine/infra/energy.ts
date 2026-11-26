import { and, eq, gt, gte, lt, or, sql } from 'drizzle-orm'
import { EnergyReport, type EnergyPeriod, type PortViewT } from '#shared/schemas/infra'
import type { z } from 'zod'
import type { Db } from '../../db'
import { energyHourly, energyLast, infraDevices, poeOffLog } from '../../db/schema'
import type { ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { normalizeDevice } from '../../unifi/device-shape'
import { UnifiError } from '../../unifi/errors'
import { DAY, HOUR, localDate, weekday, zonedInstant } from '../access-time'
import { portKey, type PortKey } from './port-history'

type Period = z.output<typeof EnergyPeriod>
type HourRow = typeof energyHourly.$inferSelect

export function observePortEnergy(db: Pick<Db, 'insert' | 'select'>, key: PortKey, port: PortViewT, at: number) {
  const watts = port.poe?.powerW
  if (watts == null) return
  const before = db.select().from(energyLast).where(portKey(energyLast, key)).get()
  if (before && before.at >= at) return
  db.insert(energyLast).values({ ...key, at }).onConflictDoUpdate({
    target: [energyLast.scope, energyLast.switchMac, energyLast.portIdx], set: { at },
  }).run()
  if (!before || at - before.at > 180_000) return
  for (let cursor = before.at; cursor < at;) {
    const hourTs = Math.floor(cursor / HOUR) * HOUR
    const end = Math.min(hourTs + HOUR, at)
    const sampledMs = end - cursor
    db.insert(energyHourly).values({ ...key, hourTs, sampledMs, wh: watts * sampledMs / HOUR,
      peerName: port.peer?.name ?? port.peer?.mac ?? null, portName: port.name }).onConflictDoUpdate({
      target: [energyHourly.scope, energyHourly.switchMac, energyHourly.portIdx, energyHourly.hourTs],
      set: { wh: sql`wh + excluded.wh`, sampledMs: sql`sampled_ms + excluded.sampled_ms`,
        peerName: sql`coalesce(excluded.peer_name, peer_name)`, portName: sql`coalesce(excluded.port_name, port_name)` },
    }).run()
    cursor = end
  }
}

export function energyPeriod(period: Period, at: number, timezone: string) {
  const date = localDate(at, timezone)
  const wall = new Date(date)
  const year = wall.getUTCFullYear()
  const month = wall.getUTCMonth()
  const monday = date - weekday(date) * DAY
  const bounds = {
    day: [date, date + DAY],
    week: [monday, monday + 7 * DAY],
    month: [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)],
    year: [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)],
  } satisfies Record<Period, [number, number]>
  const [start, end] = bounds[period]
  const from = zonedInstant(start, timezone)
  const to = zonedInstant(end, timezone)
  const boundaries: number[] = []
  if (period === 'day') {
    // Walk real hours so the repeated hour at fall-back gets its own bucket.
    for (let ts = from; ts < to; ts += HOUR) boundaries.push(ts)
  } else if (period === 'year') {
    for (let index = 0; index < 12; index++) boundaries.push(zonedInstant(Date.UTC(year, index, 1), timezone))
  } else {
    for (let ts = start; ts < end; ts += DAY) boundaries.push(zonedInstant(ts, timezone))
  }
  return { from, to, boundaries: [...new Set([...boundaries, to])] }
}

export function liveWatts(service: ControllerService) {
  const values = service.runtime?.cache.snapshot().devices
    .filter(device => device.adopted !== false && device.state !== 0 && device.state !== 6)
    .flatMap(device => normalizeDevice(device).poe?.usedW ?? []) ?? []
  return values.length ? values.reduce((total, value) => total + value, 0) : null
}

function rowsFor(db: Db, scope: string, from: number, to: number, mac?: string) {
  if (to <= from) return []
  return db.select().from(energyHourly).where(and(eq(energyHourly.scope, scope),
    gt(energyHourly.hourTs, from - HOUR), lt(energyHourly.hourTs, to),
    mac === undefined ? undefined : eq(energyHourly.switchMac, mac))).orderBy(energyHourly.hourTs).all()
}

function fraction(row: HourRow, from: number, to: number, now: number) {
  const end = Math.min(now, row.hourTs + HOUR)
  const duration = end - row.hourTs
  return duration > 0 ? Math.max(0, Math.min(end, to) - Math.max(row.hourTs, from)) / duration : 0
}

export function deviceEnergy(db: Db, scope: string, mac: string, at: number, timezone: string) {
  const { from: month } = energyPeriod('month', at, timezone)
  const { from: today } = energyPeriod('day', at, timezone)
  const rows = rowsFor(db, scope, month, at, mac)
  return { todayWh: rows.reduce((sum, row) => sum + row.wh * fraction(row, today, at, at), 0),
    monthWh: rows.reduce((sum, row) => sum + row.wh * fraction(row, month, at, at), 0) }
}

export function energyReport(db: Db, service: ControllerService, period: Period, at: number, now: number) {
  if (!Number.isFinite(new Date(at).getTime()) || at < 0 || at > Date.UTC(9998, 11, 31)) throw new UnifiError('INVALID_INPUT', 400)
  const { timezone, energy: { ratePerKwh, currency } } = createSettingsService(db).get()
  const { from, to, boundaries } = energyPeriod(period, at, timezone)
  const previous = energyPeriod(period, from - 1, timezone)
  const scope = service.runtime?.scope
  const series = boundaries.slice(0, -1).map(ts => ({ ts, byDevice: {} as Record<string, number> }))
  const byDevice = new Map<string, { mac: string, name: string, wh: number,
    ports: Map<number, { idx: number, name: string | null, peerName: string | null, wh: number }> }>()
  const names = new Map((scope ? db.select().from(infraDevices).where(eq(infraDevices.scope, scope)).all() : []).map(row => [row.mac, row.name]))
  const previousRows = scope ? rowsFor(db, scope, previous.from, Math.min(previous.to, now)) : []
  const end = Math.min(to, now)
  const rows = scope ? rowsFor(db, scope, from, end) : []
  let totalWh = 0
  let sampledMs = 0
  let bucket = 0
  for (const row of rows) {
    const part = fraction(row, from, end, now)
    if (!part) continue
    const wh = row.wh * part
    totalWh += wh
    sampledMs += row.sampledMs * part
    const device = byDevice.get(row.switchMac) ?? { mac: row.switchMac, name: names.get(row.switchMac) ?? row.switchMac, wh: 0, ports: new Map() }
    const port = device.ports.get(row.portIdx) ?? { idx: row.portIdx, name: null, peerName: null, wh: 0 }
    device.wh += wh
    port.wh += wh
    port.name = row.portName ?? port.name
    port.peerName = row.peerName ?? port.peerName
    device.ports.set(port.idx, port)
    byDevice.set(device.mac, device)
    while (bucket < series.length && boundaries[bucket + 1]! <= row.hourTs) bucket++
    for (let i = bucket; i < series.length && boundaries[i]! < row.hourTs + HOUR; i++) {
      const share = fraction(row, boundaries[i]!, Math.min(boundaries[i + 1]!, end), now)
      if (!share) continue
      const values = series[i]!.byDevice
      values[row.switchMac] = (values[row.switchMac] ?? 0) + row.wh * share
    }
  }
  const cost = (wh: number) => ratePerKwh === null ? null : wh / 1000 * ratePerKwh
  const logs = scope && end > from ? db.select().from(poeOffLog).where(and(eq(poeOffLog.scope, scope),
    lt(poeOffLog.start, end), or(gt(poeOffLog.end, from), sql`${poeOffLog.end} is null`))).all() : []
  const savings = new Map<string, { scheduleId: string, name: string, wh: number }>()
  for (const log of logs) {
    if (log.avgW === null) continue
    const entry = savings.get(log.scheduleId) ?? { scheduleId: log.scheduleId, name: log.scheduleName, wh: 0 }
    entry.wh += log.avgW * Math.max(0, Math.min(end, log.end ?? end) - Math.max(from, log.start)) / HOUR
    savings.set(log.scheduleId, entry)
  }
  const portCount = [...byDevice.values()].reduce((count, device) => count + device.ports.size, 0)
  return EnergyReport.parse({ period, from, to, timezone, ratePerKwh, currency, totalWh, cost: cost(totalWh),
    previousTotalWh: previousRows.length ? previousRows.reduce((sum, row) => sum + row.wh * fraction(row, previous.from, previous.to, now), 0) : null,
    series, byDevice: [...byDevice.values()].sort((a, b) => b.wh - a.wh).map(device => ({
      ...device, ports: [...device.ports.values()].sort((a, b) => b.wh - a.wh || a.idx - b.idx),
    })),
    savings: [...savings.values()].sort((a, b) => b.wh - a.wh).map(entry => ({ ...entry, cost: cost(entry.wh) })),
    liveW: liveWatts(service), coverage: portCount && end > from ? Math.min(1, sampledMs / ((end - from) * portCount)) : 0 })
}
