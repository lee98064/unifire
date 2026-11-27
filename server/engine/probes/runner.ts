import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db'
import { egressHealth, egressHealthTransitions, egressSamples } from '../../db/schema'
import { isGateway } from '../../services/cache'
import type { ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { liveBus } from '../../utils/bus'
import { classifyHealth, compactSamples, median, readHealth, wanStatus } from './health'
import type { createProbeRoutes } from './routes'
import { mockProbeTransport, realProbeTransport, type ProbeTransport } from './transport'

const MIN_BASELINE_SAMPLES = 5

export function createProbeRunner(db: Db, service: ControllerService, routes: ReturnType<typeof createProbeRoutes>,
  now = Date.now, transport: ProbeTransport = service.mockProbe ? mockProbeTransport(service.mockProbe) : realProbeTransport()) {
  const config = createSettingsService(db)
  let work: Promise<void> | undefined
  let lastEmission = -Infinity
  let lastCompaction = -Infinity

  async function measure() {
    const run = service.runtime
    if (!run?.active() || !service.status().connected) return
    const probe = config.get().probe
    const rows = routes.exits(run)
    if (service.status().mode === 'live' && rows.some(row => row.probeEnabled || row.probeRouteScope === run.scope)) {
      await routes.provision(undefined, false).catch(() => {})
    }
    if (!run.active()) return
    const at = now()
    const wans = rows.some(row => row.kind === 'wan' && row.enabled)
    const cachedGateway = () => run.cache.gateway()
    const [gateway, health, capable, docs] = await Promise.all([
      wans ? run.api.gateway().then(devices => devices.find(isGateway) ?? cachedGateway()).catch(cachedGateway) : null,
      wans ? run.api.health().catch(() => []) : [],
      transport.supports(probe.method),
      rows.some(row => row.probeEnabled) ? run.api.routes().catch(() => []) : [],
    ])
    const readings = await Promise.all(routes.exits(run).map(async row => {
      const info = routes.probeState(row, run, docs)
      const last = readHealth(db, row.id)
      const lastCheck = last?.value.lastCheckAt
      const continuous = lastCheck != null && at >= lastCheck && at - lastCheck <= 2_000 * probe.intervalSec
      const prior = continuous ? last : undefined
      const canMeasure = capable && info.state === 'ok' && info.ip !== null
      const attempts = canMeasure ? await Promise.all([0, 1, 2].map(attempt =>
        transport.attempt(info.ip!, probe.method, row.id, at, attempt).catch(() => null))) : null
      // Baseline = recent typical latency. Degraded samples count too: excluding them let a single low first sample
      // pin the baseline forever, so a slower-but-stable egress stayed "degraded". Judge latency only with enough history.
      const recent = attempts ? db.select({ latency: egressSamples.latencyMs }).from(egressSamples).where(and(
        eq(egressSamples.egressId, row.id), inArray(egressSamples.status, ['healthy', 'degraded']), isNotNull(egressSamples.latencyMs),
      )).orderBy(desc(egressSamples.ts)).limit(31).all().flatMap(sample => sample.latency === null ? [] : [sample.latency]) : []
      const wan = row.kind !== 'wan' ? null : row.enabled ? wanStatus(gateway, health, row.wanGroup) : false
      const measured = classifyHealth({ attempts, priorFailures: prior?.failedRounds ?? 0, failThreshold: probe.failThreshold,
        baseline: recent.length >= MIN_BASELINE_SAMPLES ? median(recent) : null, wan })
      const previous = last?.value.status
      const { status, latencyMs, lossPct, jitterMs, source } = measured.value
      const changed = previous !== status
      const signalChanged = !continuous || changed || prior?.value.lossPct !== lossPct || prior?.failedRounds !== measured.failedRounds
      return { egressId: row.id, name: row.name, wan, enabledWan: row.kind === 'wan' && row.enabled, previous, changed, signalChanged, failedRounds: measured.failedRounds,
        value: { status, latencyMs, lossPct, jitterMs, source, lastCheckAt: at, since: changed ? at : prior?.value.since ?? at } }
    }))
    if (!run.active()) return
    db.transaction(tx => {
      for (const { egressId, value, changed, failedRounds } of readings) {
        const health = { egressId, value, failedRounds }
        tx.insert(egressHealth).values(health).onConflictDoUpdate({ target: egressHealth.egressId, set: { value, failedRounds } }).run()
        tx.insert(egressSamples).values({ egressId, ts: at, status: value.status, latencyMs: value.latencyMs,
          lossPct: value.lossPct, jitterMs: value.jitterMs, intervalMs: probe.intervalSec * 1000, source: value.source }).onConflictDoNothing().run()
        if (changed) tx.insert(egressHealthTransitions).values({ egressId, ts: at, status: value.status })
          .onConflictDoUpdate({ target: [egressHealthTransitions.egressId, egressHealthTransitions.ts], set: { status: value.status } }).run()
      }
    })
    if (at - lastCompaction >= 3_600_000) {
      compactSamples(db, at)
      lastCompaction = at
    }
    service.engine.emit('event', { type: 'wan.observed', at, readings: readings.filter(row => row.enabledWan)
      .map(row => ({ id: row.egressId, name: row.name, up: row.wan })) })
    for (const { egressId, value, changed, signalChanged, previous } of readings) {
      if (signalChanged) service.engine.emit('event', { type: 'egress.healthChanged', egressId, at })
      if (!changed) continue
      if (value.status === 'down') service.engine.emit('event', { type: 'egress.down', egressId, at })
      else if (previous === 'down' && value.status !== 'unknown') service.engine.emit('event', { type: 'egress.up', egressId, at })
    }
    if (at - lastEmission >= 10_000) {
      lastEmission = at
      liveBus.emit({ type: 'egress.health', data: readings.map(({ egressId, value }) =>
        ({ egressId, status: value.status, latencyMs: value.latencyMs, lossPct: value.lossPct })) })
    }
  }

  return {
    round() {
      work ??= measure().finally(() => { work = undefined })
      return work
    },
    idle: () => work,
  }
}
