import { get as httpsGet } from 'node:https'
import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { SweepStatus, type SweepStatusT } from '#shared/schemas/egress'
import type { Db } from '../../db'
import { egressIpChecks } from '../../db/schema'
import { createAuditService } from '../../services/audit'
import { systemContext, type ControllerService } from '../../services/controller'
import { routeFingerprint } from '../../services/ownership'
import { UnifiError, unifiErrorCode, unifiStatusKey } from '../../unifi/errors'
import type { WriteContext } from '../../unifi/writes'
import { apiError } from '../../utils/api-error'
import { liveBus } from '../../utils/bus'
import { latestPublicIp } from './health'
import { SWEEP_IPS, type createProbeRoutes } from './routes'

type Trace = { ip: string, country: string | null, colo: string | null }
type TraceRead = (ip: string, signal: AbortSignal) => Promise<string | null>
type Runtime = NonNullable<ControllerService['runtime']>
const IDLE: SweepStatusT = { running: false, startedAt: null, finishedAt: null, current: null, done: 0, total: 0, results: [] }

export function parseTrace(body: string | null): Trace | null {
  if (!body) return null
  const fields = new Map(body.trim().split(/\r?\n/).flatMap(line => {
    const i = line.indexOf('=')
    return i > 0 ? [[line.slice(0, i), line.slice(i + 1)] as const] : []
  }))
  const ip = fields.get('ip')
  const country = fields.get('loc')
  const colo = fields.get('colo')
  if (!ip || !isIP(ip)) return null
  return { ip, country: country && /^[A-Z]{2}$/.test(country) ? country : null, colo: colo && /^[A-Z]{3}$/.test(colo) ? colo : null }
}

const realTrace: TraceRead = (ip, signal) => new Promise(resolve => {
  // A new TLS connection ensures UniFi classifies fresh traffic after each switch.
  const request = httpsGet({ hostname: ip, path: '/cdn-cgi/trace', agent: false,
    signal: AbortSignal.any([signal, AbortSignal.timeout(950)]) }, response => {
    if (response.statusCode !== 200) {
      response.destroy()
      resolve(null)
      return
    }
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => {
      body += chunk
      if (body.length > 8192) {
        response.destroy()
        resolve(null)
      }
    })
    response.once('error', () => resolve(null))
    response.once('end', () => resolve(body))
  })
  request.once('error', () => resolve(null))
})

export function createSweep(db: Db, service: ControllerService, routes: ReturnType<typeof createProbeRoutes>, options: {
  now?: () => number
  trace?: TraceRead
  pause?: (ms: number, signal: AbortSignal) => Promise<unknown>
} = {}) {
  const now = options.now ?? Date.now
  const pause = options.pause ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }))
  const trace: TraceRead = options.trace ?? (service.mockTrace ? async () => service.mockTrace?.() ?? null : realTrace)
  const audit = createAuditService(db, liveBus, now)
  let current = IDLE
  let work: Promise<void> | undefined
  let abort: AbortController | undefined
  let cleaning = 0
  let pendingDisable: { run: Runtime, id: string, baseline: string } | undefined

  function publish() {
    const { running, done, total } = current
    liveBus.emit({ type: 'sweep', data: { running, done, total } })
  }

  async function readStable(previous: string | null, signal: AbortSignal) {
    let last: string | null = null
    const deadline = now() + 20_000
    // The attempt cap also bounds tests and the wait if the wall clock moves backwards.
    for (let attempt = 0; attempt < 20 && now() < deadline; attempt++) {
      if (signal.aborted) return null
      const traces = (await Promise.all(SWEEP_IPS.map(ip => trace(ip, signal).then(parseTrace).catch(() => null)))).filter(
        (value): value is Trace => value !== null,
      )
      const answer = traces[0]
      if (answer && traces.every(trace => trace.ip === answer.ip) && answer.ip !== previous) {
        if (last === answer.ip) return answer
        last = answer.ip
      } else last = null
      if (attempt < 19 && now() < deadline) await pause(Math.min(1_000, deadline - now()), signal)
    }
    return null
  }

  function result(egressId: string, answer: Trace | null, latencyMs: number, error: string | null, actor: WriteContext['actor']) {
    const previous = latestPublicIp(db, egressId)?.ip ?? null
    const changed = !!answer && previous !== null && answer.ip !== previous
    const ts = now()
    db.insert(egressIpChecks).values({ egressId, ts, ip: answer?.ip ?? null,
      country: answer?.country ?? null, colo: answer?.colo ?? null, changed, latencyMs, error,
    }).onConflictDoUpdate({ target: [egressIpChecks.egressId, egressIpChecks.ts], set: {
      ip: answer?.ip ?? null, country: answer?.country ?? null, colo: answer?.colo ?? null, changed, latencyMs, error,
    } }).run()
    if (changed && answer) {
      service.engine.emit('event', { type: 'egress.ip_changed', egressId, previousIp: previous, ip: answer.ip })
      const name = routes.exits().find(exit => exit.id === egressId)?.name ?? egressId
      audit.record({ actor, category: 'egress', action: 'egress.ip_changed', severity: 'info',
        target: { type: 'egress', id: egressId, label: name }, messageKey: 'audit.egress.ipChanged',
        messageParams: { egress: name, from: previous, to: answer.ip } })
    }
    current = { ...current, done: current.done + 1, results: [...current.results, {
      egressId, ok: !!answer, ip: answer?.ip ?? null, country: answer?.country ?? null, error,
    }] }
    publish()
    return changed
  }

  async function disable(ctx: WriteContext) {
    const pending = pendingDisable
    if (!pending) return
    try {
      const { run, id, baseline } = pending
      const current = (await run.api.routes()).find(route => route._id === id)
      if (!current?.enabled) {
        pendingDisable = undefined
        return
      }
      const outcome = await run.writes.updateRoute(id, { enabled: false }, { ...ctx, probeBaseline: baseline, quietProbe: true })
        .catch(async error => {
          if (unifiErrorCode(error) !== 'UNIFI_ROUTE_DRIFT') throw error
          // Shut off our registered sweep even if it drifted while activated.
          return run.writes.repairProbe(id, { enabled: false }, { ...ctx, quietProbe: true })
        })
      if (!outcome.dryRun) pendingDisable = undefined
    } catch (error) {
      if (unifiErrorCode(error) === 'UNIFI_ROUTE_NOT_FOUND') pendingDisable = undefined
      else throw error
    }
  }

  async function runSweep(run: Runtime, mac: string, ids: string[], ctx: WriteContext, signal: AbortSignal) {
    let previous: string | null = null
    let changed = 0
    let cleanupFailed = false
    try {
      if (pendingDisable) await disable(ctx)
      const { id, draft } = await routes.ensureSweep(run, mac, ids[0]!, ctx)
      const disabled = routeFingerprint({ ...draft, _id: id })
      const enabled = routeFingerprint({ ...draft, _id: id, enabled: true })
      for (const egressId of ids) {
        if (signal.aborted || !run.active()) break
        current = { ...current, current: egressId }
        publish()
        const started = performance.now()
        let answer: Trace | null = null
        let error: string | null = null
        try {
          // Track the attempted activation even if the write succeeds but read-back fails.
          const route = (await run.api.routes()).find(route => route._id === id)
          if (!route) throw new UnifiError('UNIFI_ROUTE_NOT_FOUND')
          const expected = route.enabled && pendingDisable ? enabled : disabled
          pendingDisable = { run, id, baseline: enabled }
          const applied = await run.writes.updateRoute(id, { network_id: egressId, enabled: true }, { ...ctx, probeBaseline: expected, quietProbe: true })
          if (applied.dryRun) throw new UnifiError('SWEEP_DRY_RUN')
          answer = await readStable(previous, signal)
          if (answer) previous = answer.ip
          else error = 'probe.detail.traceTimeout'
        } catch (cause) {
          if (signal.aborted) break
          error = unifiErrorCode(cause) === 'SWEEP_DRY_RUN' ? 'probe.detail.dryRun' : unifiStatusKey(unifiErrorCode(cause))
        }
        if (signal.aborted || !run.active()) break
        if (result(egressId, answer, Math.round(performance.now() - started), error, ctx.actor)) changed++
      }
    } catch (error) {
      if (!signal.aborted && run.active()) {
        for (const id of ids.slice(current.done)) result(id, null, 0, unifiStatusKey(unifiErrorCode(error)), ctx.actor)
      }
    } finally {
      try { await disable(ctx) } catch {
        cleanupFailed = true
        // Keep the pending route for a later live retry or an explicit cleanup.
      }
      const ok = current.results.filter(row => row.ok).length
      const failed = current.total - ok
      current = { ...current, running: false, current: null, finishedAt: now() }
      publish()
      audit.record({ actor: ctx.actor, category: 'egress', action: 'egress.sweepDone',
        severity: failed || cleanupFailed ? 'warning' : 'success', messageKey: 'audit.egress.sweepDone',
        messageParams: { total: String(current.total), ok: String(ok), changed: String(changed), failed: String(failed) } })
    }
  }

  function get() { return SweepStatus.parse(current) }

  function start(egressIds?: string[], ctx: WriteContext = systemContext) {
    if (work || cleaning || service.routingLocked()) return get()
    const run = service.runtime
    if (!run?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    const status = service.status()
    const exits = routes.exits(run).filter(row => row.enabled)
    const ids = [...new Set(egressIds ?? exits.map(row => row.id))]
    if (ids.some(id => !exits.some(row => row.id === id))) throw new UnifiError('EGRESS_NOT_FOUND', 404)
    if (!ids.length) return get()
    if (status.mode === 'dry-run' || ctx.dryRun) {
      audit.record({ actor: ctx.actor, category: 'egress', action: 'egress.sweepDryRun', severity: 'info',
        messageKey: 'audit.egress.sweepDryRun', messageParams: { total: String(ids.length) }, dryRun: true })
      current = { ...IDLE, startedAt: now(), finishedAt: now(), done: ids.length, total: ids.length,
        results: ids.map(egressId => ({ egressId, ok: false, ip: null, country: null, error: 'probe.detail.dryRun' })) }
      publish()
      return get()
    }
    if (!status.selfMac) throw apiError(409, 'PROBE_SELF_MAC_REQUIRED', 'probe.detail.selfMacRequired')
    abort = new AbortController()
    current = { ...IDLE, running: true, startedAt: now(), total: ids.length }
    publish()
    work = runSweep(run, status.selfMac, ids, ctx, abort.signal).finally(() => { work = undefined; abort = undefined })
    void work.catch(() => {})
    return get()
  }

  async function cancel(strict = false) {
    abort?.abort()
    await work
    if (!pendingDisable) return
    try { await disable(systemContext) } catch (error) { if (strict) throw error }
  }

  async function cleanup(ctx: WriteContext) {
    cleaning++
    try {
      await cancel()
      const overview = await routes.cleanup(ctx)
      if (service.status().mode === 'live' && !ctx.dryRun) pendingDisable = undefined
      return overview
    } finally { cleaning-- }
  }

  async function recoverIdle() {
    const run = service.runtime
    if (work || cleaning || service.routingLocked() || !run?.active() || service.status().mode !== 'live') return
    const mac = service.status().selfMac
    if (!mac || !routes.sweepId(run)) return
    cleaning++
    try {
      const doc = (await run.api.routes()).find(doc => doc._id === routes.sweepId(run))
      if (doc?.enabled && doc.network_id) await routes.ensureSweep(run, mac, doc.network_id, systemContext)
      pendingDisable = undefined
    } finally { cleaning-- }
  }

  return { get, start, cancel, cleanup, recoverIdle, idle: () => work }
}
