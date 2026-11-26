import { gzipSync, gunzipSync } from 'node:zlib'
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from '../../db'
import { egressReportArchive, egressSamples } from '../../db/schema'
import { HOUR } from '../access-time'

type Sample = Pick<typeof egressSamples.$inferSelect, 'ts' | 'status' | 'latencyMs' | 'lossPct' | 'intervalMs'>
type Entry = [offset: number, status: Sample['status'], latency: number | null, loss: number | null, interval: number | null]
const decode = (buffer: Buffer) => JSON.parse(gunzipSync(buffer).toString('utf8')) as Entry[]
export const utcHour = (ts: number) => Math.floor(ts / HOUR) * HOUR

// Called inside the same transaction that creates the chart rollups and deletes the raw samples.
export function archiveReportSamples(tx: Pick<Db, 'select' | 'insert'>, from: number, to: number) {
  const rows = tx.select().from(egressSamples).where(and(gte(egressSamples.ts, from), lt(egressSamples.ts, to)))
    .orderBy(asc(egressSamples.egressId), asc(egressSamples.ts)).all()
  let egressId: string | undefined
  let ts = 0
  let entries: Entry[] = []
  const save = () => {
    if (egressId === undefined) return
    const old = tx.select({ samples: egressReportArchive.samples }).from(egressReportArchive)
      .where(and(eq(egressReportArchive.egressId, egressId), eq(egressReportArchive.ts, ts))).get()
    if (old) {
      const merged = new Map(decode(old.samples).map(entry => [entry[0], entry]))
      for (const entry of entries) merged.set(entry[0], entry)
      entries = [...merged.values()].sort((a, b) => a[0] - b[0])
    }
    const samples = gzipSync(JSON.stringify(entries))
    tx.insert(egressReportArchive).values({ egressId, ts, samples })
      .onConflictDoUpdate({ target: [egressReportArchive.egressId, egressReportArchive.ts], set: { samples } }).run()
  }
  for (const row of rows) {
    const hour = utcHour(row.ts)
    if (egressId !== row.egressId || hour !== ts) {
      save()
      egressId = row.egressId
      ts = hour
      entries = []
    }
    entries.push([row.ts - ts, row.status, row.latencyMs, row.lossPct, row.intervalMs])
  }
  save()
}

export function reportSamples(db: Db, egressId: string, from: number, to: number) {
  const archives = db.select().from(egressReportArchive).where(and(eq(egressReportArchive.egressId, egressId),
    gte(egressReportArchive.ts, utcHour(from)), lt(egressReportArchive.ts, to))).orderBy(asc(egressReportArchive.ts)).all()
  const archivedHours = new Set(archives.map(row => row.ts))
  const samples: Sample[] = []
  for (const archive of archives) {
    for (const [offset, status, latencyMs, lossPct, intervalMs] of decode(archive.samples)) {
      const ts = archive.ts + offset
      if (ts >= from && ts < to) samples.push({ ts, status, latencyMs, lossPct, intervalMs })
    }
  }
  const raw = db.select({ ts: egressSamples.ts, status: egressSamples.status, latencyMs: egressSamples.latencyMs,
    lossPct: egressSamples.lossPct, intervalMs: egressSamples.intervalMs }).from(egressSamples)
    .where(and(eq(egressSamples.egressId, egressId), gte(egressSamples.ts, from), lt(egressSamples.ts, to)))
    .orderBy(asc(egressSamples.ts)).all()
  // A wall-clock adjustment can temporarily put a new raw sample into an archived hour.
  if (samples.length && raw.length && samples.at(-1)!.ts >= raw[0]!.ts) {
    const byTime = new Map(samples.map(sample => [sample.ts, sample]))
    for (const sample of raw) byTime.set(sample.ts, sample)
    return { samples: [...byTime.values()].sort((a, b) => a.ts - b.ts), archivedHours }
  }
  return { samples: samples.concat(raw), archivedHours }
}
