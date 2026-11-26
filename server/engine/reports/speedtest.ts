import { createHash } from 'node:crypto'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { SpeedtestStatus } from '#shared/schemas/insight'
import type { Db } from '../../db'
import { egresses, speedtests } from '../../db/schema'
import type { ControllerService } from '../../services/controller'
import { isUnsupported, unifiErrorCode } from '../../unifi/errors'
import { readSpeedtest, type SpeedtestReading } from '../../unifi/speedtest'
import type { WriteContext } from '../../unifi/writes'
import { apiError } from '../../utils/api-error'

type Runtime = NonNullable<ControllerService['runtime']>
type Pending = { run: Runtime, startedAt: number, baseline: Set<string>, observedRunning: boolean }
const pollMs = 2_000
const timeoutMs = 3 * 60_000
const unsupported = () => apiError(409, 'SPEEDTEST_UNSUPPORTED', 'errors.speedtestUnsupported')
const identity = (reading: SpeedtestReading) => JSON.stringify(reading)

export function createSpeedtests(db: Db, service: ControllerService, now = Date.now) {
  let pending: Pending | undefined
  let startWork: Promise<void> | undefined
  let readWork: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let refreshed: { run: Runtime, at: number } | undefined
  let stopped = false

  const capable = () => service.status().capabilities.some(entry => entry.key === 'speedtest' && entry.status === 'ok')
  function status() {
    const run = service.runtime
    const last = db.select().from(speedtests)
      .where(run ? or(eq(speedtests.scope, run.scope), isNull(speedtests.scope)) : isNull(speedtests.scope))
      .orderBy(desc(speedtests.ts), desc(speedtests.id)).limit(1).get()
    const active = pending?.run === run ? pending : undefined
    return SpeedtestStatus.parse({ running: !!active, startedAt: active?.startedAt ?? null, last: last ?? null })
  }

  function save(run: Runtime, results: SpeedtestReading[], start?: number) {
    if (!results.length) return
    const wans = db.select().from(egresses).where(and(eq(egresses.site, run.config.site), eq(egresses.kind, 'wan'))).all()
    const group = (name?: string | null) => name?.toLowerCase().replace(/^wan$/, 'wan1')
    db.transaction(tx => {
      for (const reading of results) {
        const egressId = reading.wan ? wans.find(wan => wan.id === reading.wan || group(wan.wanGroup) === group(reading.wan))?.id ?? null : null
        const id = createHash('sha256').update(JSON.stringify([run.scope, reading.ts ?? start ?? null, reading.wan,
          ...(reading.ts === null ? [reading.downMbps, reading.upMbps, reading.latencyMs] : [])])).digest('hex')
        tx.insert(speedtests).values({ id, scope: run.scope, egressId, ts: reading.ts ?? now(), downMbps: reading.downMbps,
          upMbps: reading.upMbps, latencyMs: reading.latencyMs }).onConflictDoNothing().run()
      }
    })
  }

  function schedule() {
    clearTimeout(timer)
    if (stopped || !pending) return
    timer = setTimeout(() => {
      void refresh(pending?.run).finally(schedule)
    }, pollMs)
    timer.unref()
  }

  function refresh(run = service.runtime) {
    if (!run?.active() || stopped) {
      pending = undefined
      return Promise.resolve()
    }
    if (readWork) return readWork
    const current = pending
    if (current && (current.run !== run || now() - current.startedAt >= timeoutMs)) {
      pending = undefined
      return Promise.resolve()
    }
    readWork = (async () => {
      const state = await readSpeedtest(run.api)
      if (stopped || !run.active()) return
      refreshed = { run, at: now() }
      if (!current) {
        save(run, state.results.filter(result => result.ts !== null))
        if (state.running && !startWork) {
          pending = { run, startedAt: now(), baseline: new Set(state.results.map(identity)), observedRunning: true }
          schedule()
        }
        return
      }
      current.observedRunning ||= state.running
      const results = state.results.filter(result => !current.baseline.has(identity(result))
        || result.ts === null && current.observedRunning && state.results.length === 1)
      if (!state.running && results.length) {
        save(run, results, current.startedAt)
        if (pending === current) pending = undefined
      }
    })().catch(() => {}).finally(() => { readWork = undefined })
    return readWork
  }

  async function start(context: WriteContext) {
    if (startWork) {
      await startWork
      return status()
    }
    const run = service.runtime
    if (stopped || !run?.active() || !capable()) throw unsupported()
    if (pending?.run === run) return status()
    startWork = (async () => {
      await readWork
      if (pending?.run === run) return
      const previous = await readSpeedtest(run.api)
      if (stopped || !run.active()) return
      save(run, previous.results.filter(result => result.ts !== null))
      const baseline = new Set(previous.results.map(identity))
      const startedAt = now()
      if (previous.running && service.status().mode === 'live') {
        pending = { run, startedAt, baseline, observedRunning: true }
        schedule()
        return
      }
      try {
        const result = await run.writes.deviceAction({ cmd: 'speedtest' }, context)
        if (result.dryRun) return
      } catch (error) {
        if (isUnsupported(error)) throw unsupported()
        if (['UNIFI_TIMEOUT', 'UNIFI_UNREACHABLE'].includes(unifiErrorCode(error))) {
          pending = { run, startedAt, baseline, observedRunning: false }
          schedule()
        }
        throw error
      }
      pending = { run, startedAt, baseline, observedRunning: false }
      schedule()
    })().finally(() => { startWork = undefined })
    await startWork
    return status()
  }

  return {
    async get() {
      const run = service.runtime
      if (run && !pending && !startWork && capable() && service.status().connected
        && (refreshed?.run !== run || now() - refreshed.at >= 5_000)) await refresh(run)
      return status()
    },
    start,
    async stop() {
      stopped = true
      clearTimeout(timer)
      await Promise.allSettled([startWork, readWork])
    },
  }
}
