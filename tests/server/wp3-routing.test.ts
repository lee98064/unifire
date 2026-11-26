import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FailoverPolicy } from '../../shared/schemas/routes'
import { emptyGrid } from '../../shared/utils/schedule'
import { createDatabase } from '../../server/db'
import { egresses, egressIpChecks, egressSampleRollups, egressSamples, managedRoutes } from '../../server/db/schema'
import { createManagedRoutes } from '../../server/engine/managed-routes'
import { classifyHealth, compactSamples, egressHistory, unknownHealth, wanStatus } from '../../server/engine/probes/health'
import { createProbeRoutes } from '../../server/engine/probes/routes'
import { createProbeRunner } from '../../server/engine/probes/runner'
import { createSweep } from '../../server/engine/probes/sweep'
import { nextHourBoundary, startReconciler } from '../../server/engine/reconciler'
import { clearFailover, previewSegments, resolveEgress, type HealthReading } from '../../server/engine/route-desired'
import { createAuditService } from '../../server/services/audit'
import { createControllerService, systemContext } from '../../server/services/controller'
import { createInventory } from '../../server/services/inventory'
import { createSettingsService } from '../../server/services/settings'
import { createUnifiTransport } from '../../server/unifi/client'
import { DEMO_ROUTES } from '../../server/unifi/mock/fixtures'
import type { WireRoute } from '../../server/unifi/endpoints/schemas'
import type { ControllerEvent } from '../../server/unifi/ws'
import { initializeCrypto } from '../../server/utils/crypto'
import { UnifiError } from '../../server/unifi/errors'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const monday = Date.UTC(2026, 10, 23)
const ctx = systemContext
const wan = 'demo-wan-1'
const vpn = 'demo-vpn-1'

describe('WP3 desired state', () => {
  it('prioritizes override, failover, schedule, and default with continuous healthy recovery', () => {
    const grid = emptyGrid()
    grid[0]![1] = vpn
    const timing = { defaultEgressId: wan, schedule: { timezone: 'UTC', grid, generator: null }, override: null }
    const policy = FailoverPolicy.parse({ enabled: true, chain: ['unknown', 'backup'], failThreshold: 2, lossPct: 80, recoverMinutes: 2 })
    const enabled = new Set([wan, vpn, 'unknown', 'backup'])
    const health = new Map<string, HealthReading>([['backup', { value: { ...unknownHealth, status: 'healthy' }, failedRounds: 0 }]])
    const at = monday + HOUR
    const reading = (status: HealthReading['value']['status'], lossPct: number, failedRounds: number, since = at) => {
      health.set(vpn, { value: { ...unknownHealth, status, since, lossPct }, failedRounds })
    }
    expect(resolveEgress(timing, policy, clearFailover, health, monday, enabled).desired.reason).toBe('default')
    reading('degraded', 50, 1)
    expect(resolveEgress(timing, policy, clearFailover, health, at, enabled).desired).toMatchObject({ egressId: vpn, reason: 'schedule' })
    reading('degraded', 50, 2)
    const failed = resolveEgress(timing, policy, clearFailover, health, at, enabled)
    expect(failed.desired).toMatchObject({ egressId: 'backup', reason: 'failover' })
    reading('degraded', 90, 0)
    expect(resolveEgress(timing, policy, clearFailover, health, at, enabled).desired.reason).toBe('failover')
    const override = { id: 'over', managedRouteId: 'route', egressId: 'unknown', createdBy: 'user:1',
      startsAt: at, endsAt: at + 1_000, reason: null }
    expect(resolveEgress({ ...timing, override }, policy, failed.latch, health, at, enabled).desired)
      .toMatchObject({ egressId: 'unknown', reason: 'override' })
    reading('healthy', 0, 0, at + 1_000)
    const stabilizing = resolveEgress(timing, policy, failed.latch, health, at + 1_000, enabled)
    expect(stabilizing.desired).toMatchObject({ egressId: 'backup', reason: 'failover', until: at + 121_000 })
    expect(resolveEgress(timing, policy, stabilizing.latch, health, at + 120_999, enabled).desired.reason).toBe('failover')
    expect(resolveEgress(timing, policy, stabilizing.latch, health, at + 121_000, enabled).desired)
      .toMatchObject({ egressId: vpn, reason: 'recover' })
    reading('healthy', 0, 0, at + 60_000)
    expect(resolveEgress(timing, policy, stabilizing.latch, health, at + 121_000, enabled).desired.reason).toBe('failover')
  })

  it('previews clipped override, default and schedule segments and aligns non-hour-offset zones', () => {
    const grid = emptyGrid()
    grid[0]![1] = vpn
    const at = monday + HOUR / 2
    const timing = { defaultEgressId: wan, schedule: { timezone: 'UTC', grid, generator: null },
      override: { id: 'over', managedRouteId: 'route', egressId: 'manual', createdBy: 'user:1',
        startsAt: at, endsAt: at + 600_000, reason: null } }
    expect(previewSegments(timing, at, monday + HOUR * 2.5)).toEqual([
      { start: at, end: at + 600_000, egressId: 'manual', reason: 'override' },
      { start: at + 600_000, end: monday + HOUR, egressId: wan, reason: 'default' },
      { start: monday + HOUR, end: monday + HOUR * 2, egressId: vpn, reason: 'schedule' },
      { start: monday + HOUR * 2, end: monday + HOUR * 2.5, egressId: wan, reason: 'default' },
    ])
    expect(nextHourBoundary(monday, 'Asia/Kathmandu')).toBe(monday + HOUR / 4)
  })

  it('classifies total failures, partial loss, excess latency, and a UniFi-down WAN', () => {
    const input = { priorFailures: 0, failThreshold: 3, baseline: 10, wan: null }
    expect(classifyHealth({ ...input, attempts: [8, 10, 12] }).value)
      .toMatchObject({ status: 'healthy', latencyMs: 10, jitterMs: 2, lossPct: 0 })
    expect(classifyHealth({ ...input, attempts: [9, null, 11] }).value.status).toBe('degraded')
    expect(classifyHealth({ ...input, attempts: [25, 26, 28] }).value.status).toBe('degraded')
    expect(classifyHealth({ ...input, attempts: [null, null, null] }).value.status).toBe('degraded')
    expect(classifyHealth({ ...input, attempts: [null, null, null], priorFailures: 2 }).value.status).toBe('down')
    expect(classifyHealth({ ...input, attempts: null }).value.status).toBe('unknown')
    expect(classifyHealth({ ...input, attempts: [8, 10, 12], wan: false }).value).toMatchObject({ status: 'down', source: 'unifi' })
    expect(wanStatus(null, [{ subsystem: 'wan', status: 'down' }], 'WAN2')).toBeNull()
    expect(wanStatus(null, [{ subsystem: 'wan', status: 'down' }], 'WAN')).toBe(false)
  })
})

describe('WP3 with fake UniFi', () => {
  let database: ReturnType<typeof createDatabase>
  let service: Awaited<ReturnType<typeof createControllerService>>
  let external: ReturnType<typeof createUnifiTransport>
  let managed: ReturnType<typeof createManagedRoutes>
  let at: number

  beforeEach(async () => {
    database = createDatabase()
    initializeCrypto(Buffer.alloc(32, 57))
    service = await createControllerService(database.db, { mock: true })
    await service.ready()
    external = createUnifiTransport(service.runtime!.config, { mock: true })
    at = Date.now()
    managed = createManagedRoutes(database.db, service, () => at)
  })

  afterEach(async () => {
    await external.close()
    await service.stop()
    database.sqlite.close()
  })

  async function document(id: string) {
    const docs = await service.runtime!.api.routes()
    return docs.find(route => route._id === id)!
  }

  async function edit(id: string, patch: Partial<WireRoute>) {
    await external.write('PUT', external.paths.v2(`trafficroutes/${id}`), { ...await document(id), ...patch })
    await service.runtime!.cache.refresh('routes')
  }

  async function newRoute(egress = wan) {
    return managed.create({ mode: 'create', name: 'Test route', targets: [{ type: 'CLIENT', mac: '02:00:00:00:00:01' }],
      matchingTarget: 'DOMAIN', destinations: ['example.test'], killSwitch: true, defaultEgressId: egress }, ctx)
  }

  it('seeds three managed routes and protects excluded, object, predefined, and unadopted routes', async () => {
    expect(managed.list().map(row => row.name)).toEqual(expect.arrayContaining(['Proxy host hourly rotation', 'Kids tablets', 'Lab NAS']))
    expect(managed.get('demo-managed-proxy').schedule?.grid[0]?.slice(0, 8)).toEqual([
      wan, vpn, 'demo-vpn-2', 'demo-vpn-3', 'demo-vpn-2', 'demo-vpn-4', vpn, 'demo-vpn-5',
    ])
    expect(managed.get('demo-managed-nas').activeOverride?.endsAt).toBeGreaterThan(at + HOUR)
    for (const id of [DEMO_ROUTES.external, 'demo-route-17', 'demo-route-20']) {
      await expect(managed.create({ mode: 'adopt', unifiRouteId: id }, ctx)).rejects.toMatchObject({ code: 'ROUTE_NOT_OWNED' })
    }
    const docs = await Promise.all([DEMO_ROUTES.external, 'demo-route-17', 'demo-route-20', 'demo-route-2'].map(document))
    await managed.reconcile()
    expect(await Promise.all(docs.map(doc => document(doc._id)))).toEqual(docs)
  })

  it('records external edits and distinguishes an observed write by Unifire', async () => {
    const id = 'demo-route-2'
    const runtime = service.runtime!
    const owners = () => createInventory(database.db, service).routes().find(row => row.id === id)!
    const base = Date.now()
    for (const [i, network_id] of [vpn, 'demo-vpn-2', 'demo-vpn-3'].entries()) {
      await external.write('PUT', external.paths.v2(`trafficroutes/${id}`), { ...await document(id), network_id })
      runtime.observations.observe(await runtime.api.routes(), base + i)
    }
    await runtime.cache.refresh('routes')
    expect(owners()).toMatchObject({ lastExternalChangeAt: base + 2, suspectedAutomation: true })
    await expect(managed.create({ mode: 'adopt', unifiRouteId: id, acknowledgeAutomation: false }, ctx)).rejects.toMatchObject({
      data: { code: 'ROUTE_EXTERNALLY_AUTOMATED' },
    })
    // Once the admin confirms the outside script is stopped, the route can be taken over.
    const adopted = await managed.create({ mode: 'adopt', unifiRouteId: id, acknowledgeAutomation: true }, ctx)
    expect(adopted.unifiRouteId).toBe(id)
    await managed.release(adopted.id, false, ctx)
    const created = await newRoute()
    await runtime.cache.refresh('routes')
    await managed.update(created.id, { defaultEgressId: vpn }, ctx)
    await managed.reconcile()
    await vi.waitFor(() => expect(runtime.cache.snapshot().routes.find(row => row._id === created.unifiRouteId)?.network_id).toBe(vpn))
    expect(runtime.observations.details(created.unifiRouteId)).toEqual({ lastExternalChangeAt: null, suspectedAutomation: false })
  })

  it('preserves unknown fields, pauses on drift and resumes with an explicitly accepted baseline', async () => {
    const route = await newRoute()
    const events: ControllerEvent[] = []
    service.engine.on('event', event => events.push(event))
    expect(await document(route.unifiRouteId)).toMatchObject({
      matching_target: 'DOMAIN', domains: [{ domain: 'example.test', ports: [], port_ranges: [] }],
      kill_switch_enabled: true, next_hop: '',
    })
    const patch = { kill_switch_enabled: false, demo_extension: { version: 3 }, domains: [{ domain: 'other.test' }] }
    await edit(route.unifiRouteId, patch)
    await managed.update(route.id, { defaultEgressId: vpn }, ctx)
    await managed.reconcile()
    expect(managed.get(route.id)).toMatchObject({ state: 'drift', stateDetail: 'route.state.drift' })
    expect(events).toContainEqual({ type: 'notification', event: 'route_drift', managedRouteId: route.id })
    expect((await document(route.unifiRouteId)).network_id).toBe(wan)
    await managed.update(route.id, { enabled: false }, ctx)
    expect(managed.get(route.id).state).toBe('drift')
    expect(await managed.resume(route.id, ctx)).toMatchObject({ state: 'active', destinations: ['other.test'], killSwitch: false })
    expect(await managed.update(route.id, { killSwitch: true }, ctx)).toMatchObject({ killSwitch: true })
    await managed.reconcile()
    expect(await document(route.unifiRouteId)).toMatchObject({ ...patch, kill_switch_enabled: true, network_id: vpn })
    expect(managed.log({ managedRouteId: route.id }).items).toMatchObject([{ verified: true, toEgressId: vpn, dryRun: false }])
    await external.write('DELETE', external.paths.v2(`trafficroutes/${route.unifiRouteId}`))
    await managed.reconcile()
    expect(managed.get(route.id)).toMatchObject({ state: 'error', stateDetail: 'route.state.missing' })
    await expect(managed.release(route.id, true, ctx)).resolves.toEqual({ ok: true })
  })

  it('keeps a controller-assigned route visible after a failed create read-back and reconciles it on retry', async () => {
    const runtime = service.runtime!
    const routes = runtime.api.routes
    vi.spyOn(runtime.api, 'routes').mockImplementationOnce(routes)
      .mockRejectedValueOnce(new UnifiError('UNIFI_TIMEOUT'))
    await expect(newRoute()).rejects.toMatchObject({ code: 'UNIFI_TIMEOUT' })
    const recovered = managed.list().find(route => route.name === 'Test route')!
    expect(recovered).toMatchObject({ state: 'error' })
    expect((await routes()).filter(route => route._id === recovered.unifiRouteId)).toHaveLength(1)
    await managed.reconcile()
    expect(managed.get(recovered.id).state).toBe('active')
  })

  it('records dry-run intent without a PUT or a last-switch timestamp', async () => {
    const route = await newRoute()
    await service.setMode('dry-run', ctx)
    await managed.update(route.id, { defaultEgressId: vpn }, ctx)
    await managed.reconcile()
    await managed.reconcile()
    expect(await document(route.unifiRouteId)).toMatchObject({ network_id: wan })
    expect(managed.get(route.id)).toMatchObject({ actualEgressId: wan, lastSwitchAt: null, desired: { egressId: vpn } })
    expect(managed.log({ managedRouteId: route.id }).items).toMatchObject([{ dryRun: true, verified: false, toEgressId: vpn }])
    const preview = await newRoute()
    expect(preview).toMatchObject({ state: 'pending', actualEgressId: null })
    expect(managed.list().some(route => route.id === preview.id)).toBe(false)
    await managed.release(route.id, true, ctx)
    expect(managed.get(route.id).id).toBe(route.id)
    await service.setMode('live', ctx)
    await managed.reconcile()
    expect(await document(route.unifiRouteId)).toMatchObject({ network_id: vpn })
    await managed.release(route.id, true, ctx)
    expect(await document(route.unifiRouteId)).toBeUndefined()
  })

  it('arms an hour-boundary reconcile, verifies the switch and paginates its log', async () => {
    const route = await newRoute()
    const grid = emptyGrid()
    grid[0]![1] = vpn
    at = monday + HOUR - 650
    await managed.schedule(route.id, { timezone: 'UTC', grid, generator: null }, ctx)
    expect(managed.get(route.id).next).toMatchObject({ at: monday + HOUR, egressId: vpn })
    const clockStart = Date.now()
    const clock = () => monday + HOUR - 650 + (Date.now() - clockStart)
    const timed = createManagedRoutes(database.db, service, () => at = clock())
    const stop = startReconciler(service, timed, clock)
    try {
      await vi.waitFor(async () => {
        expect((await document(route.unifiRouteId)).network_id).toBe(vpn)
        expect(timed.log({ managedRouteId: route.id }).items[0])
          .toMatchObject({ reason: 'schedule', verified: true, fromEgressId: wan, toEgressId: vpn })
      }, { timeout: 2_000 })
      const audit = createAuditService(database.db).list({ category: 'route' }).items
      expect(audit.filter(entry => entry.action === 'route.switched' && entry.target?.id === route.id)).toMatchObject([
        { diff: [{ path: 'network_id', before: wan, after: vpn }] },
      ])
      expect(audit.filter(entry => entry.action === 'routes.update')).toEqual([])
      expect(timed.log({ managedRouteId: route.id }).items[0]!.ts - (monday + HOUR)).toBeLessThan(1_000)
    } finally { await stop() }
    at += HOUR
    await managed.reconcile()
    const first = managed.log({ managedRouteId: route.id, limit: 1 })
    expect(first.nextCursor).toBeTruthy()
    const next = managed.log({ managedRouteId: route.id, limit: 1, cursor: first.nextCursor! })
    expect(next).toMatchObject({ items: [{ reason: 'schedule' }], nextCursor: null })
    expect(next.items[0]!.id).not.toBe(first.items[0]!.id)
  })

  it('provisions probes with unique stable IPs, repairs drift, and stores health and incident history', async () => {
    const db = database.db
    const probes = createProbeRoutes(db, service)
    const config = createSettingsService(db)
    config.patch({ probe: { ...config.get().probe, ipPool: ['1.1.1.1', '1.0.0.1', ...config.get().probe.ipPool] } })
    await service.setMode('dry-run', ctx)
    expect((await probes.provision()).routes.every(row => row.state === 'missing')).toBe(true)
    await service.setMode('live', ctx)
    const provisioned = (await probes.provision()).routes
    expect(provisioned.every(row => row.state === 'ok')).toBe(true)
    expect(new Set(provisioned.map(row => row.ip)).size).toBe(provisioned.length)
    expect(provisioned.map(row => row.ip)).not.toContain('1.1.1.1')
    const id = provisioned.find(row => row.egressId === vpn)!.routeId!
    await edit(id, { kill_switch_enabled: false, network_id: wan, demo_extension: { retained: true } })
    expect(probes.overview().routes.find(route => route.egressId === vpn)?.state).toBe('error')
    expect((await probes.provision()).routes.find(route => route.egressId === vpn)).toMatchObject({ routeId: id, state: 'ok' })
    expect(await document(id)).toMatchObject({ kill_switch_enabled: true, network_id: vpn, demo_extension: { retained: true } })
    let failed = false
    const runner = createProbeRunner(db, service, probes, () => at, {
      supports: async () => true,
      attempt: async (_ip, _method, exit, _at, attempt) => exit === vpn && failed ? null : 10 + attempt,
    })
    const events: string[] = []
    service.engine.on('event', event => { if ('egressId' in event && event.egressId === vpn) events.push(event.type) })
    await runner.round()
    failed = true
    for (let i = 0; i < 3; i++) { at += 30_000; await runner.round() }
    failed = false
    at += 30_000
    await runner.round()
    expect(events).toEqual(expect.arrayContaining(['egress.down', 'egress.up']))
    const history = egressHistory(db, vpn, true, '1h', at)
    expect(history.samples.map(row => row.status)).toEqual(['healthy', 'degraded', 'degraded', 'down', 'healthy'])
    expect(history.incidents).toEqual([{ start: at - 90_000, end: at - 30_000, status: 'degraded' },
      { start: at - 30_000, end: at, status: 'down' }])
    const removed = await probes.cleanup(ctx)
    expect(removed.routes.every(row => row.state === 'missing')).toBe(true)
    expect(removed.routes.map(row => row.ip)).toEqual(provisioned.map(row => row.ip))
    expect(createAuditService(db).list({ category: 'egress', q: 'probesProvisioned' }).items.map(row => row.messageParams))
      .toEqual(expect.arrayContaining([
        { created: String(provisioned.length), repaired: '0', removed: '0' },
        { created: '0', repaired: '1', removed: '0' },
        { created: '0', repaired: '0', removed: String(provisioned.length) },
      ]))
    expect(createAuditService(db).list({ category: 'route', q: '[unifire-probe]' }).items).toEqual([])
  })

  it('compacts raw data into minute and ten-minute buckets and caps history at 360 points', () => {
    const db = database.db
    const now = Date.UTC(2026, 11, 20)
    const bins = [now - 31 * DAY, now - 8 * DAY]
    for (const ts of bins) db.insert(egressSamples).values([
      { egressId: wan, ts, latencyMs: 10, lossPct: 0, status: 'healthy' },
      { egressId: wan, ts: ts + 10_000, latencyMs: 20, lossPct: 33, status: 'degraded' },
    ]).run()
    for (let i = 0; i < 400; i++) db.insert(egressSamples).values({ egressId: wan, ts: now - i * 8_000, status: 'healthy' }).run()
    compactSamples(db, now)
    compactSamples(db, now)
    expect(db.select().from(egressSampleRollups).all()).toMatchObject([
      { resolution: 60_000, latencyTotal: 30, latencyCount: 2, status: 'degraded' },
      { resolution: 600_000, latencyTotal: 30, latencyCount: 2, status: 'degraded' },
    ])
    expect(egressHistory(db, wan, true, '1h', now).samples.length).toBeLessThanOrEqual(360)
  })

  it('sweeps the currently selected fake egress, records change and timeout, then disables the route', async () => {
    const db = database.db
    const probes = createProbeRoutes(db, service)
    const sweep = createSweep(db, service, probes, { now: () => at, pause: async ms => { at += ms } })
    db.insert(egressIpChecks).values({ egressId: wan, ts: at - 1000, ip: '192.0.2.15' }).run()
    const events: ControllerEvent[] = []
    service.engine.on('event', event => events.push(event))
    expect(sweep.start([wan, vpn]).running).toBe(true)
    await sweep.idle()
    expect(sweep.get()).toMatchObject({ running: false, done: 2, results: [
      { ok: true, ip: '198.51.100.11' }, { ok: true, ip: '198.51.100.14' },
    ] })
    expect(events).toContainEqual({ type: 'egress.ip_changed', egressId: wan, previousIp: '192.0.2.15', ip: '198.51.100.11' })
    expect(await document(probes.sweepId(service.runtime!)!)).toMatchObject({ enabled: false })
    const timedOut = createSweep(db, service, probes, { now: () => at, pause: async ms => { at += ms },
      trace: async () => 'ip=198.51.100.11\nloc=TW\ncolo=TPE' })
    timedOut.start([wan, vpn])
    await timedOut.idle()
    expect(timedOut.get().results).toMatchObject([{ ok: true }, { ok: false, error: 'probe.detail.traceTimeout' }])
    expect(await document(probes.sweepId(service.runtime!)!)).toMatchObject({ enabled: false })
    expect(db.select().from(egressIpChecks).where(eq(egressIpChecks.egressId, vpn)).all()).toHaveLength(2)
    const audit = createAuditService(db)
    expect(audit.list({ category: 'egress', q: 'sweepDone' }).items.map(row => row.messageParams)).toEqual([
      { total: '2', ok: '1', changed: '0', failed: '1' }, { total: '2', ok: '2', changed: '1', failed: '0' },
    ])
    expect(audit.list({ category: 'egress', q: 'ipChanged' }).items).toHaveLength(1)
    expect(audit.list({ category: 'route', q: '[unifire-probe]' }).items).toEqual([])
  })

  it('stops an active sweep and disables its route before switching to dry-run', async () => {
    const probes = createProbeRoutes(database.db, service)
    const sweep = createSweep(database.db, service, probes, { trace: async () => null })
    const cancel = () => sweep.cancel(true)
    service.beforeRoutingChange.add(cancel)
    try {
      sweep.start([wan])
      await vi.waitFor(async () => {
        const id = probes.sweepId(service.runtime!)
        expect(id && (await document(id)).enabled).toBe(true)
      })
      await service.setMode('dry-run', ctx)
      expect(sweep.get().running).toBe(false)
      expect(await document(probes.sweepId(service.runtime!)!)).toMatchObject({ enabled: false })
      expect(sweep.start([wan]).results).toMatchObject([{ ok: false, error: 'probe.detail.dryRun' }])
    } finally {
      await sweep.cancel()
      service.beforeRoutingChange.delete(cancel)
    }
  })
})
