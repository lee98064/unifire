import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { EgressHistory, type EgressHealthT, type EgressHistoryT, type HealthStatusT, type PublicIpT } from '#shared/schemas/egress'
import type { Db } from '../../db'
import { egressHealth, egressHealthTransitions, egressIpChecks, egressSampleRollups, egressSamples } from '../../db/schema'
import type { WireDevice, WireDoc } from '../../unifi/endpoints/schemas'
import { wanTelemetry } from '../../unifi/wan'
import { UnifiError } from '../../unifi/errors'
import { archiveReportSamples, utcHour } from '../reports/egress-archive'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const rangeMs = { '1h': 60 * MINUTE, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
const severity = { healthy: 0, unknown: 1, degraded: 2, down: 3 }

export const unknownHealth: EgressHealthT = {
  status: 'unknown', latencyMs: null, lossPct: null, jitterMs: null, lastCheckAt: null, since: null, source: 'none',
}

export function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2
}

export function classifyHealth(input: { attempts: (number | null)[] | null, priorFailures: number, failThreshold: number,
  baseline: number | null, wan: boolean | null }) {
  const successes = input.attempts?.filter((value): value is number => value !== null) ?? []
  const latencyMs = median(successes)
  const lossPct = input.attempts ? 100 * (input.attempts.length - successes.length) / input.attempts.length : null
  const jitterMs = median(successes.slice(1).map((value, i) => Math.abs(value - successes[i]!)))
  const failedRounds = input.wan !== false && lossPct === 100 ? input.priorFailures + 1 : 0
  const status: HealthStatusT = input.wan === false || failedRounds >= input.failThreshold ? 'down'
    : lossPct === null ? input.wan === true ? 'healthy' : 'unknown'
      : lossPct > 0 || latencyMs !== null && input.baseline !== null && latencyMs > 2.5 * input.baseline ? 'degraded' : 'healthy'
  const source = input.wan === false ? 'unifi' : input.attempts ? 'probe' : input.wan === null ? 'none' : 'unifi'
  return { value: { status, latencyMs, lossPct, jitterMs, source } satisfies Partial<EgressHealthT>, failedRounds }
}

function statusOf(value: WireDoc | null | undefined) {
  if (!value) return null
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : null
  if (value.up === false || value.is_up === false || value.reachable === false || value.is_reachable === false
    || status && ['down', 'error', 'offline', 'disconnected', 'failed'].includes(status)) return false
  if (value.up === true || value.is_up === true || value.reachable === true || value.is_reachable === true
    || status && ['ok', 'up', 'healthy', 'connected', 'online'].includes(status)) return true
  return null
}

export function wanStatus(gateway: WireDevice | null, records: WireDoc[], group: string | null) {
  const name = group?.toLowerCase()
  const key = name === 'wan' || name === 'wan1' ? 'wan1' : name === 'wan2' ? 'wan2' : name === 'wan3' ? 'wan3' : null
  if (!key) return null
  const reports = records.filter(record => [record.subsystem, record.wan_networkgroup, record.wan]
    .some(value => typeof value === 'string' && (value.toLowerCase() === key || key === 'wan1' && value.toLowerCase() === 'wan')))
  const statuses = [statusOf(wanTelemetry(gateway, group)), ...reports.map(statusOf)]
  return statuses.includes(false) ? false : statuses.includes(true) ? true : null
}

export function latestPublicIp(db: Db, id: string): PublicIpT | null {
  const row = db.select().from(egressIpChecks).where(and(eq(egressIpChecks.egressId, id), sql`${egressIpChecks.ip} IS NOT NULL`))
    .orderBy(desc(egressIpChecks.ts)).limit(1).get()
  return row?.ip ? { ip: row.ip, country: row.country, colo: row.colo, checkedAt: row.ts, changed: row.changed } : null
}

function worst(a: HealthStatusT, b: HealthStatusT) {
  return severity[a] >= severity[b] ? a : b
}

export function history(db: Db, egressId: string, range: EgressHistoryT['range'], now: number) {
  const from = Math.max(0, now - rangeMs[range])
  const raw = db.select().from(egressSamples).where(and(eq(egressSamples.egressId, egressId), gte(egressSamples.ts, from))).all()
  const rollup = db.select().from(egressSampleRollups)
    .where(and(eq(egressSampleRollups.egressId, egressId), gte(egressSampleRollups.ts, from))).all()
  const points = raw.length + rollup.length
  const bucketSize = Math.ceil(rangeMs[range] / 360)
  const buckets = new Map<number, typeof rollup[number]>()
  for (const entry of [
    ...rollup,
    ...raw.map(row => ({ ...row, resolution: 0, latencyTotal: row.latencyMs ?? 0, latencyCount: Number(row.latencyMs !== null),
      lossTotal: row.lossPct ?? 0, lossCount: Number(row.lossPct !== null) })),
  ].sort((a, b) => a.ts - b.ts)) {
    const key = points <= 360 ? entry.ts : Math.min(359, Math.floor((entry.ts - from) / bucketSize))
    const previous = buckets.get(key)
    if (previous) {
      previous.latencyTotal += entry.latencyTotal
      previous.latencyCount += entry.latencyCount
      previous.lossTotal += entry.lossTotal
      previous.lossCount += entry.lossCount
      previous.status = worst(previous.status, entry.status)
    } else buckets.set(key, { ...entry })
  }
  const samples = Array.from(buckets.values(), row => ({
    ts: row.ts, status: row.status,
    latencyMs: row.latencyCount ? row.latencyTotal / row.latencyCount : null,
    lossPct: row.lossCount ? row.lossTotal / row.lossCount : null,
  }))
  const checks = db.select().from(egressIpChecks).where(and(eq(egressIpChecks.egressId, egressId), gte(egressIpChecks.ts, from)))
    .orderBy(asc(egressIpChecks.ts)).all().flatMap(row => row.ip
      ? [{ ip: row.ip, country: row.country, colo: row.colo, checkedAt: row.ts, changed: row.changed }] : [])
  const earlier = db.select().from(egressHealthTransitions)
    .where(and(eq(egressHealthTransitions.egressId, egressId), lt(egressHealthTransitions.ts, from)))
    .orderBy(desc(egressHealthTransitions.ts)).limit(1).get()
  const transitions = db.select().from(egressHealthTransitions)
    .where(and(eq(egressHealthTransitions.egressId, egressId), gte(egressHealthTransitions.ts, from)))
    .orderBy(asc(egressHealthTransitions.ts)).all()
  if (earlier) transitions.unshift(earlier)
  const incidents = transitions.flatMap((row, index) => {
    const end = transitions[index + 1]?.ts ?? null
    return (row.status === 'down' || row.status === 'degraded') && (end === null || end > from)
      ? [{ start: Math.max(from, row.ts), end, status: row.status }] : []
  })
  return EgressHistory.parse({ egressId, range, samples, ipChecks: checks, incidents })
}

export function compactSamples(db: Db, now: number) {
  const rawCutoff = utcHour(now - 7 * DAY)
  const minuteCutoff = Math.floor((now - 30 * DAY) / (10 * MINUTE)) * (10 * MINUTE)
  const rank = sql`max(CASE status WHEN 'down' THEN 3 WHEN 'degraded' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END)`
  const worstStatus = sql`CASE ${rank} WHEN 3 THEN 'down' WHEN 2 THEN 'degraded' WHEN 1 THEN 'unknown' ELSE 'healthy' END`
  db.transaction(tx => {
    archiveReportSamples(tx, 0, rawCutoff)
    tx.run(sql`
      INSERT INTO egress_sample_rollups
        (egress_id, resolution, ts, latency_total, latency_count, loss_total, loss_count, status)
      SELECT egress_id, ${MINUTE}, CAST(ts / ${MINUTE} AS INTEGER) * ${MINUTE},
        coalesce(sum(latency_ms), 0), count(latency_ms), coalesce(sum(loss_pct), 0), count(loss_pct), ${worstStatus}
      FROM egress_samples WHERE ts < ${rawCutoff} GROUP BY egress_id, CAST(ts / ${MINUTE} AS INTEGER)
    `)
    tx.delete(egressSamples).where(lt(egressSamples.ts, rawCutoff)).run()
    tx.run(sql`
      INSERT INTO egress_sample_rollups
        (egress_id, resolution, ts, latency_total, latency_count, loss_total, loss_count, status)
      SELECT egress_id, ${10 * MINUTE}, CAST(ts / ${10 * MINUTE} AS INTEGER) * ${10 * MINUTE},
        sum(latency_total), sum(latency_count), sum(loss_total), sum(loss_count), ${worstStatus}
      FROM egress_sample_rollups WHERE resolution = ${MINUTE} AND ts < ${minuteCutoff}
      GROUP BY egress_id, CAST(ts / ${10 * MINUTE} AS INTEGER)
    `)
    tx.delete(egressSampleRollups).where(and(eq(egressSampleRollups.resolution, MINUTE), lt(egressSampleRollups.ts, minuteCutoff))).run()
  })
}

export function egressHistory(db: Db, id: string, exists: boolean, range: EgressHistoryT['range'], now = Date.now()) {
  if (!exists) throw new UnifiError('EGRESS_NOT_FOUND', 404)
  return history(db, id, range, now)
}

export function readHealth(db: Db, id: string) {
  return db.select().from(egressHealth).where(eq(egressHealth.egressId, id)).get()
}
