import { and, count, eq, gte, gt, lt, or, isNull, sql } from 'drizzle-orm'
import { InfraReport } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { deviceRollupsHourly, deviceSamples, deviceTransitions, firmwareHistory, incidents, infraDevices, portEvents } from '../../db/schema'
import type { ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { HOUR, MINUTE, zonedInstant } from '../access-time'
import { energyReport } from '../infra/energy'
import { reportMonth } from './period'

export function infrastructureReport(db: Db, service: ControllerService, month: string, now = Date.now()) {
  const { timezone } = createSettingsService(db).get()
  const wall = reportMonth(month)
  const from = Math.max(0, zonedInstant(wall.from, timezone))
  const to = zonedInstant(wall.to, timezone)
  const end = Math.min(to, now)
  const scope = service.runtime?.scope
  const sampled = new Set<number>()
  const fleet = scope && end > from ? db.select().from(infraDevices).where(eq(infraDevices.scope, scope))
    .orderBy(infraDevices.type, infraDevices.name, infraDevices.mac).all() : []
  const devices = fleet.map(({ mac, name, type, model }) => {
    let minutes = 0
    let onlineMinutes = 0
    let cpuSum = 0, cpuCount = 0, memSum = 0, memCount = 0
    let tempMax: number | null = null
    function observe(ts: number, online: boolean, cpu: number | null, mem: number | null, temp: number | null) {
      sampled.add(ts)
      minutes++
      onlineMinutes += Number(online)
      if (cpu !== null) { cpuSum += cpu; cpuCount++ }
      if (mem !== null) { memSum += mem; memCount++ }
      if (temp !== null && (tempMax === null || temp > tempMax)) tempMax = temp
    }
    const raw = db.select().from(deviceSamples)
      .where(and(eq(deviceSamples.mac, mac), gte(deviceSamples.ts, from), lt(deviceSamples.ts, end))).all()
    const rawMinutes = new Set(raw.map(row => row.ts))
    const rollups = db.select({ ts: deviceRollupsHourly.hourTs, data: deviceRollupsHourly.reportMinutes }).from(deviceRollupsHourly)
      .where(and(eq(deviceRollupsHourly.mac, mac), gte(deviceRollupsHourly.hourTs, Math.floor(from / HOUR) * HOUR),
        lt(deviceRollupsHourly.hourTs, end))).all()
    for (const { ts, data } of rollups) {
      if (!data) continue
      for (const [offset, online, cpu, mem, temp] of data) {
        const at = ts + offset * MINUTE
        if (at >= from && at < end && !rawMinutes.has(at)) observe(at, online === 1, cpu, mem, temp)
      }
    }
    for (const row of raw) observe(row.ts, row.state === 'online' || row.planned, row.cpu, row.mem, row.temp)

    const history = db.select({
      outages: count(sql`case when ${deviceTransitions.to} = 'offline' and ${deviceTransitions.planned} = 0 then 1 end`),
      reboots: count(sql`case when ${deviceTransitions.reason} = 'unexpected_reboot' then 1 end`),
    }).from(deviceTransitions).where(and(eq(deviceTransitions.mac, mac), gte(deviceTransitions.ts, from),
      lt(deviceTransitions.ts, end))).get()!
    const firmware = db.select({ total: count() }).from(firmwareHistory)
      .where(and(eq(firmwareHistory.mac, mac), gte(firmwareHistory.ts, from), lt(firmwareHistory.ts, end))).get()!
    const ports = db.select({ total: count() }).from(portEvents).where(and(eq(portEvents.scope, scope!),
      eq(portEvents.switchMac, mac), gte(portEvents.ts, from), lt(portEvents.ts, end))).get()!

    return { mac, name, type, model, availability: minutes ? onlineMinutes / minutes : null,
      downtimeSec: (minutes - onlineMinutes) * 60, outages: history.outages, unexpectedReboots: history.reboots,
      firmwareChanges: firmware.total, cpuAvg: cpuCount ? cpuSum / cpuCount : null,
      memAvg: memCount ? memSum / memCount : null, tempMax, portEvents: ports.total }
  })

  const rows = scope && end > from ? db.select().from(incidents)
    .where(and(eq(incidents.scope, scope), lt(incidents.openedAt, end),
      or(isNull(incidents.resolvedAt), gt(incidents.resolvedAt, from)))).all() : []
  const duration = (row: typeof rows[number]) => Math.max(0, Math.min(row.resolvedAt ?? end, end) - Math.max(row.openedAt, from)) / 1000
  const resolved = rows.filter(row => row.resolvedAt !== null && row.resolvedAt < end)
  const kinds = new Map<typeof rows[number]['root']['kind'], number>()
  for (const { root } of rows) kinds.set(root.kind, (kinds.get(root.kind) ?? 0) + 1)
  const energy = end > from && from > 0 ? energyReport(db, service, 'month', from, now) : null
  return InfraReport.parse({
    month, from, to, coverage: end > from ? Math.min(1, sampled.size / ((end - from) / MINUTE)) : 0,
    devices, energyWh: energy?.coverage ? energy.totalWh : null,
    incidents: { count: rows.length, critical: rows.filter(row => row.severity === 'critical').length,
      totalSec: rows.reduce((total, row) => total + duration(row), 0),
      mttrSec: resolved.length ? resolved.reduce((total, row) => total + (row.resolvedAt! - row.openedAt) / 1000, 0) / resolved.length : null,
      byRoot: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      longest: rows.sort((a, b) => duration(b) - duration(a) || b.openedAt - a.openedAt || a.id.localeCompare(b.id)).slice(0, 5),
    },
  })
}
