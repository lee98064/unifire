import { and, asc, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { IspReport, type IspReportT } from '#shared/schemas/insight'
import type { Db } from '../../db'
import { egresses, egressIpChecks, egressSampleRollups, speedtests } from '../../db/schema'
import { zonedInstant } from '../access-time'
import { median } from '../probes/health'
import { reportSamples, utcHour } from './egress-archive'
import { reportDays, reportMonth } from './period'

type Outage = IspReportT['wans'][number]['outages'][number]
type Sample = ReturnType<typeof reportSamples>['samples'][number]
const maxGap = 900_000 // At most 1.5 intervals at the supported 10-minute cadence.
const uptime = (known: number, down: number) => known ? 100 * (known - down) / known : null

function outages(samples: Sample[], from: number, to: number, intervalMs: number, current: boolean) {
  const spans: Outage[] = []
  let start: number | null = null
  for (const [index, sample] of samples.entries()) {
    if (sample.status !== 'down') continue
    if (start === null) start = sample.ts
    const interval = sample.intervalMs ?? intervalMs
    const next = samples[index + 1]
    const adjacent = next !== undefined && next.ts - sample.ts <= 1.5 * interval
    if (adjacent && next.status === 'down') continue
    const observed = adjacent ? next.ts : sample.ts + interval
    const live = current && !next && to - sample.ts <= 1.5 * interval
    const end = live ? to : Math.min(to, observed)
    const clippedStart = Math.max(from, start)
    if (end > clippedStart) spans.push({ start: clippedStart, end: live ? null : end, durationSec: (end - clippedStart) / 1000 })
    start = null
  }
  return spans
}

export function ispReport(db: Db, month: string, timezone: string, site: string, scope: string | undefined, intervalMs: number,
  now = Date.now()): IspReportT {
  const period = reportMonth(month)
  const from = Math.max(0, zonedInstant(period.from, timezone))
  const monthEnd = zonedInstant(period.to, timezone)
  const to = Math.min(now + 1, monthEnd)
  const days = reportDays(period.from, period.to, timezone)
  const periodRows = and(gte(speedtests.ts, from), lt(speedtests.ts, to))
  const tests = db.select().from(speedtests).where(and(periodRows,
    scope ? or(eq(speedtests.scope, scope), isNull(speedtests.scope)) : isNull(speedtests.scope))).orderBy(asc(speedtests.ts)).all()
  const result: IspReportT = { month, generatedAt: now, wans: [], vpns: [], speedtests: tests }
  for (const egress of db.select().from(egresses).where(eq(egresses.site, site)).orderBy(asc(egresses.id)).all()) {
    const { samples, archivedHours } = reportSamples(db, egress.id, Math.max(0, from - maxGap), to)
    const daily = days.map(day => ({ date: day.date, known: 0, down: 0, latencies: [] as number[] }))
    const latencies: number[] = []
    let known = 0
    let down = 0
    let loss = 0
    let lossCount = 0
    let dayIndex = 0
    for (const sample of samples) {
      if (sample.ts < from) continue
      while (dayIndex + 1 < days.length && sample.ts >= days[dayIndex + 1]!.start) dayIndex++
      const day = daily[dayIndex]!
      if (sample.status !== 'unknown') { known++; day.known++ }
      if (sample.status === 'down') { down++; day.down++ }
      if (sample.latencyMs !== null) { latencies.push(sample.latencyMs); day.latencies.push(sample.latencyMs) }
      if (sample.lossPct !== null) { loss += sample.lossPct; lossCount++ }
    }
    const summary = { egressId: egress.id, name: egress.name, uptimePct: uptime(known, down), latencyP50: median(latencies) }
    if (egress.kind !== 'wan') {
      result.vpns.push(summary)
      continue
    }
    // Pre-WP7 rollups retained loss sums/counts, but discarded individual statuses and latency distributions.
    const legacy = db.select().from(egressSampleRollups).where(and(eq(egressSampleRollups.egressId, egress.id),
      gte(egressSampleRollups.ts, from), lt(egressSampleRollups.ts, to))).all()
    for (const row of legacy) {
      if (row.ts + row.resolution > to || archivedHours.has(utcHour(row.ts))) continue
      loss += row.lossTotal
      lossCount += row.lossCount
    }
    const checks = db.select({ ip: egressIpChecks.ip, ts: egressIpChecks.ts }).from(egressIpChecks)
      .where(and(eq(egressIpChecks.egressId, egress.id), gte(egressIpChecks.ts, from), lt(egressIpChecks.ts, to),
        isNotNull(egressIpChecks.ip))).orderBy(asc(egressIpChecks.ts)).all()
    const publicIps = new Map<string, IspReportT['wans'][number]['publicIps'][number]>()
    for (const { ip, ts } of checks) {
      if (!ip) continue
      const previous = publicIps.get(ip)
      if (previous) previous.lastSeen = ts
      else publicIps.set(ip, { ip, firstSeen: ts, lastSeen: ts })
    }
    latencies.sort((a, b) => a - b)
    result.wans.push({ ...summary, latencyP95: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null,
      lossPct: lossCount ? loss / lossCount : null, outages: outages(samples, from, to, intervalMs, to < monthEnd),
      daily: daily.map(day => ({ date: day.date, uptimePct: uptime(day.known, day.down), latencyP50: median(day.latencies) })),
      publicIps: [...publicIps.values()],
    })
  }
  return IspReport.parse(result)
}
