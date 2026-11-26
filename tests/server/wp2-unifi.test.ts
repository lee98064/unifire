import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerModeT } from '../../shared/schemas/controller'
import type { AuditEventT } from '../../shared/schemas/insight'
import { createDatabase } from '../../server/db'
import { blocks, controller, personDevices, people } from '../../server/db/schema'
import { createUnifiTransport } from '../../server/unifi/client'
import { createUnifiEndpoints } from '../../server/unifi/endpoints'
import { startMockController, type MockController } from '../../server/unifi/mock'
import { SELF_MAC } from '../../server/unifi/mock/fixtures'
import { inspectCertificate } from '../../server/unifi/tls'
import { createWriteGate, type BeforeWrite } from '../../server/unifi/writes'
import { checkWebSocket, parseControllerEvents, startEvents, type ControllerEvent } from '../../server/unifi/ws'
import { createControllerService, savedController } from '../../server/services/controller'
import { createInventory } from '../../server/services/inventory'
import { classifyRoute, routeFingerprint } from '../../server/services/ownership'
import { initializeCrypto } from '../../server/utils/crypto'

const ctx = { actor: { type: 'system' as const, id: null, name: null } }
const tls = {
  key: readFileSync(new URL('./fixtures/wp2-test-key.pem', import.meta.url)),
  cert: readFileSync(new URL('./fixtures/wp2-test-cert.pem', import.meta.url)),
}

describe('WP2 UniFi adapter', () => {
  let mock: MockController
  let transport: ReturnType<typeof createUnifiTransport>
  let api: ReturnType<typeof createUnifiEndpoints>
  let now: number

  beforeEach(async () => {
    now = Date.now()
    mock = await startMockController({ now: () => now })
    transport = createUnifiTransport(mock.config, { mock: true, now: () => now, random: () => 0.5 })
    api = createUnifiEndpoints(transport)
  })
  afterEach(async () => {
    await transport.close()
    await mock.close()
  })

  function gate() {
    let mode: ControllerModeT = 'live'
    const baseline = new Map<string, string>()
    const managed = new Map<string, { id: string }>()
    const excluded = new Set<string>()
    const probes = new Set<string>()
    const records: { action: string, dryRun?: boolean, diff?: AuditEventT['diff'] }[] = []
    const audit = { record: vi.fn((entry) => { records.push(entry); return entry }) }
    const hooks = new Set<BeforeWrite>()
    const writes = createWriteGate(transport, api, {
      site: mock.config.site, mode: () => mode, ownership: () => ({ managed, excluded, probes }),
      baseline: id => baseline.get(id), active: () => true, preWrite: () => true, audit, hooks,
    })
    return { writes, setMode: (value: ControllerModeT) => { mode = value }, baseline, managed, excluded, probes, records, hooks }
  }

  it('logs in once for simultaneous requests, renews one expired session and handles a classic login-required envelope', async () => {
    await Promise.all([api.sysinfo(), api.networks(), api.routes(), api.sites()])
    expect(mock.loginAttempts).toBe(1)
    mock.expireSession()
    await Promise.all([api.sysinfo(), api.networks(), api.routes()])
    expect(mock.loginAttempts).toBe(2)
    mock.injectFailure('GET', mock.paths.classic('stat/sysinfo'), 'loginRequired')
    expect((await api.sysinfo())[0]?.version).toBe('11.0.104')
    expect(mock.loginAttempts).toBe(3)

    mock.injectFailure('GET', mock.paths.classic('stat/sysinfo'), '401')
    mock.injectFailure('GET', mock.paths.classic('stat/sysinfo'), '401')
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_AUTH_REQUIRED' })
    expect(mock.loginAttempts).toBe(4)
  })

  it('distinguishes HTML, 404, empty collections, and classic client fallback', async () => {
    const path = mock.paths.v2('clients/active')
    mock.injectFailure('GET', path, '404')
    expect(await api.activeClients()).toHaveLength(29)
    mock.injectFailure('GET', path, 'html')
    await expect(api.activeClients()).rejects.toMatchObject({ code: 'UNIFI_HTML' })
    expect(await api.portForwards()).toHaveLength(1)
    expect(await api.firewallZones()).toHaveLength(1)
    expect(await api.firewallPolicies()).toHaveLength(1)
    expect(await api.routing()).toEqual([])
    expect(await api.staticDns()).toHaveLength(1)
    expect(await api.qosRules()).toEqual([])
    expect(await api.portConf()).toHaveLength(1)
    mock.injectFailure('GET', mock.paths.classic('rest/user'), '404')
    expect(await api.knownClients()).toHaveLength(35)
  })

  it('backs off and stops after three consecutive rejected logins until reconnect', async () => {
    mock.injectFailure('POST', mock.paths.login, '429')
    mock.injectFailure('POST', mock.paths.login, '403')
    mock.injectFailure('POST', mock.paths.login, '401')
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_RATE_LIMITED' })
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_LOGIN_BACKOFF' })
    expect(mock.loginAttempts).toBe(1)
    now += 1000
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_FORBIDDEN' })
    now += 1999
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_LOGIN_BACKOFF' })
    now += 1
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_AUTH_REQUIRED' })
    now += 60_000
    await expect(api.sysinfo()).rejects.toMatchObject({ code: 'UNIFI_AUTH_LOCKED' })
    expect(transport.lastError()).toBe('UNIFI_AUTH_LOCKED')
    expect(mock.loginAttempts).toBe(3)
    await transport.reconnect()
    await expect(api.sysinfo()).resolves.toHaveLength(1)
    expect(mock.loginAttempts).toBe(4)
    expect(transport.lastError()).toBeNull()
  })

  it('blocks forbidden ownership and drift even in dry run and audits without mutating', async () => {
    const { writes, baseline, managed, excluded, probes, records, setMode } = gate()
    const all = await api.routes()
    excluded.add('demo-route-1')
    managed.set('demo-route-1', { id: 'owned' })
    managed.set('demo-route-17', { id: 'owned-object' })
    probes.add('demo-route-2')
    for (const [id, owner] of [[1, 'excluded'], [17, 'object'], [20, 'predefined'], [2, 'external']] as const) {
      const route = all.find(route => route._id === `demo-route-${id}`)!
      expect(classifyRoute(route, { managed, excluded, probes })).toBe(owner)
      await expect(writes.updateRouteEgress(route._id, 'demo-wan-3', ctx)).rejects.toMatchObject({ code: 'ROUTE_NOT_OWNED' })
    }
    const route = all[2]!
    managed.set(route._id, { id: 'owned' })
    expect(classifyRoute(route, { managed, excluded, probes })).toBe('managed')
    expect(classifyRoute({ ...route, description: '[unifire-probe] sample' }, { managed, excluded, probes })).toBe('managed')
    probes.add(route._id)
    expect(classifyRoute({ ...route, description: '[unifire-probe] sample' }, { managed, excluded, probes })).toBe('probe')
    baseline.set(route._id, routeFingerprint({ ...route, kill_switch_enabled: false }))
    await expect(writes.updateRouteEgress(route._id, 'demo-wan-3', ctx)).rejects.toMatchObject({ code: 'UNIFI_ROUTE_DRIFT' })
    baseline.set(route._id, routeFingerprint(route))
    setMode('dry-run')
    const desired = 'demo-vpn-2'
    await expect(writes.updateRouteEgress(route._id, desired, ctx)).resolves.toMatchObject({ dryRun: true, changed: true, verified: false })
    expect(records.at(-1)).toMatchObject({ dryRun: true, diff: [{ path: 'network_id', after: desired }] })
    expect(mock.mutationCount).toBe(0)
    expect((await api.routes()).find(item => item._id === route._id)).toEqual(route)
  })

  it('serializes full-document PUTs, rotates CSRF and verifies the egress while preserving unknown fields', async () => {
    const { writes, baseline, managed, records, hooks } = gate()
    const route = (await api.routes())[0]!
    managed.set(route._id, { id: 'owned' })
    baseline.set(route._id, routeFingerprint(route))
    const hook = vi.fn()
    hooks.add(hook)
    const ids = ['demo-vpn-1', 'demo-wan-2']
    const results = await Promise.all(ids.map(id => writes.updateRouteEgress(route._id, id, ctx)))
    expect(results.every(result => result.changed && result.verified && result.durationMs >= 0)).toBe(true)
    expect((await api.routes()).find(item => item._id === route._id)).toEqual({ ...route, network_id: ids[1] })
    expect(records.map(record => record.diff?.[0]?.after)).toEqual(ids)
    expect(hook).toHaveBeenCalledTimes(2)
    expect(mock.mutationCount).toBe(2)
    expect(mock.loginAttempts).toBe(1)
  })

  it('verifies full user and WLAN updates, and simulates speed tests, PoE, and egress outages', async () => {
    const { writes } = gate()
    const prior = (await api.user('demo-client-5'))[0]!
    await expect(writes.updateUser('demo-client-5', { name: 'Renamed NAS' }, ctx)).resolves.toMatchObject({ verified: true })
    expect((await api.user('demo-client-5'))[0]).toEqual({ ...prior, name: 'Renamed NAS' })
    await expect(writes.updateWlan('demo-wlan-0', { enabled: false }, ctx)).resolves.toMatchObject({ verified: true })
    expect((await api.wlan('demo-wlan-0'))[0]).toMatchObject({ enabled: false, x_passphrase: 'fixture-only' })
    const switchDevice = (await api.devices()).find(device => device.type === 'usw')!
    await writes.deviceAction({ cmd: 'power-cycle', mac: switchDevice.mac, port_idx: 11 }, ctx)
    const entry = () => api.devices().then(devices => devices.find(device => device.mac === switchDevice.mac)
      ?.port_table?.find(port => port.port_idx === 11))
    expect(await entry()).toMatchObject({ up: false })
    await vi.waitFor(async () => expect(await entry()).toMatchObject({ up: true }), { timeout: 3000 })
    await writes.deviceAction({ cmd: 'speedtest' }, ctx)
    expect(await api.speedtestStatus()).toMatchObject([{ status: 'running' }])
    now += 2200
    expect(await api.speedtestStatus()).toMatchObject([{ status: 'finished', latency: 7 }])
    mock.scheduleOutage('demo-vpn-1', { start: now - 1000, end: now + 1000 })
    expect(mock.probe('demo-vpn-1')).toMatchObject({ up: false, latencyMs: null, country: 'JP' })
    expect(mock.probe('demo-vpn-1', now + 2000)).toMatchObject({ up: true, country: 'JP' })
  })

  it('parses typed WebSocket events and reconnects with a new session', async () => {
    const emitter = new EventEmitter<{ event: [ControllerEvent] }>()
    const seen: ControllerEvent[] = []
    const connected: boolean[] = []
    emitter.on('event', event => seen.push(event))
    const stop = startEvents(transport, emitter, value => connected.push(value))
    try {
      await vi.waitFor(() => expect(connected).toEqual([true]))
      mock.emit('events', [
        { key: 'EVT_WU_Connected', user: SELF_MAC },
        { key: 'EVT_WU_Roam', user: SELF_MAC },
        { key: 'EVT_LU_Disconnected', user: SELF_MAC },
      ])
      mock.emit('device:sync', [{ mac: SELF_MAC }])
      mock.emit('sta:sync', [{ mac: SELF_MAC }])
      mock.emit('user:add', [{ mac: SELF_MAC }])
      await vi.waitFor(() => expect(seen.map(event => event.type)).toEqual(['controller.reconnected', 'client.connected',
        'client.roam', 'client.disconnected', 'device.updated', 'client.updated', 'user.updated']))
      mock.expireSession()
      await vi.waitFor(() => expect(connected).toEqual([true, false, true]), { timeout: 4000 })
      expect(mock.loginAttempts).toBe(2)
      expect(parseControllerEvents('bad json')).toEqual([])
    } finally { stop() }
  })
})

describe('WP2 controller and cache', () => {
  it('inspects a self-signed certificate and enforces pinning and CA for HTTP and WebSocket', async () => {
    const mock = await startMockController({ tls })
    const connections: ReturnType<typeof createUnifiTransport>[] = []
    function configure(trust: Partial<Parameters<typeof createUnifiTransport>[0]>) {
      const transport = createUnifiTransport({ ...mock.config, ...trust })
      connections.push(transport)
      return transport
    }
    try {
      const cert = await inspectCertificate(mock.config.url)
      expect(cert).toMatchObject({ selfSigned: true, altNames: ['IP Address:127.0.0.1', 'DNS:localhost'] })
      const pin = configure({ verifyMode: 'fingerprint', fingerprint: cert.fingerprint })
      await expect(createUnifiEndpoints(pin).sysinfo()).resolves.toHaveLength(1)
      await expect(checkWebSocket(pin)).resolves.toBeUndefined()
      const ca = configure({ verifyMode: 'ca', caPem: tls.cert.toString('utf8') })
      await expect(createUnifiEndpoints(ca).sysinfo()).resolves.toHaveLength(1)
      await expect(checkWebSocket(ca)).resolves.toBeUndefined()
      const bad = configure({ verifyMode: 'fingerprint', fingerprint: mock.wrongFingerprint })
      await expect(createUnifiEndpoints(bad).sysinfo()).rejects.toMatchObject({ code: 'UNIFI_FINGERPRINT_MISMATCH' })
      await expect(checkWebSocket({ ...pin, connect: bad.connect })).rejects.toMatchObject({ code: 'UNIFI_FINGERPRINT_MISMATCH' })
      expect(mock.loginAttempts).toBe(2)
    } finally {
      await Promise.all(connections.map(connection => connection.close()))
      await mock.close()
    }
  })

  it('tests candidate credentials read-only and saves real-controller credentials encrypted in dry run', async () => {
    const fake = await startMockController({ tls })
    const { db, sqlite } = createDatabase()
    initializeCrypto(Buffer.alloc(32, 32))
    const service = await createControllerService(db, { mock: false })
    try {
      const cert = await inspectCertificate(fake.config.url)
      const candidate = { ...fake.config, verifyMode: 'fingerprint' as const, fingerprint: cert.fingerprint }
      expect(await service.test(candidate, ctx)).toMatchObject({ connected: true, mode: 'dry-run', selfMac: SELF_MAC })
      expect(savedController(db)).toBeUndefined()
      expect(fake.mutationCount).toBe(0)
      expect(await service.save(candidate, ctx)).toMatchObject({ connected: true, mode: 'dry-run', selfMac: SELF_MAC })
      expect(savedController(db)?.encryptedPassword).toMatch(/^v1\./)
      expect(savedController(db)?.encryptedPassword).not.toContain(candidate.password)
      const client = createInventory(db, service).clients().find(item => item.online && item.mac !== SELF_MAC)!
      const inventory = createInventory(db, service)
      await vi.waitFor(() => expect(service.status().wsConnected).toBe(true))
      fake.setOnline(client.mac, false)
      await vi.waitFor(() => expect(inventory.client(client.mac).online).toBe(false), { timeout: 2000 })
      await service.setMode('live', ctx)
      await expect(inventory.clientAction(client.mac, { action: 'block' }, ctx))
        .rejects.toMatchObject({ code: 'UNIFI_QUALIFICATION_REQUIRED' })
      expect(fake.mutationCount).toBe(0)
      expect((await service.probe(ctx)).capabilities.find(item => item.key === 'routes.create')?.status).toBe('ok')
      await expect(inventory.clientAction(client.mac, { action: 'block' }, ctx)).resolves.toMatchObject({ blocked: true })
      // A restart re-runs the boot check in dry-run; the earlier live pass must still be reported.
      await service.runtime!.qualify({ ...ctx, dryRun: true })
      expect(service.status().capabilities.find(item => item.key === 'routes.create')?.status).toBe('ok')
      const mutationCount = fake.mutationCount
      const updated = await service.save({ ...candidate, verifyMode: 'ca', caPem: tls.cert.toString(), password: undefined }, ctx)
      expect(updated).toMatchObject({ mode: 'dry-run', verifyMode: 'ca', connected: true })
      expect(fake.mutationCount).toBe(mutationCount)
    } finally {
      await service.stop()
      await fake.close()
      sqlite.close()
    }
  })

  it('seeds mock inventory, qualifies live and dry-run capabilities, and owns manual blocks', async () => {
    const { db, sqlite } = createDatabase()
    initializeCrypto(Buffer.alloc(32, 31))
    const service = await createControllerService(db, { mock: true })
    try {
      await service.ready()
      const inventory = createInventory(db, service)
      expect(service.status()).toMatchObject({ connected: true, mode: 'live', selfMac: SELF_MAC })
      expect(savedController(db)).toBeUndefined()
      expect(db.select().from(controller).all()).toHaveLength(1)
      expect(db.select().from(people).all()).toHaveLength(4)
      expect(db.select().from(personDevices).all()).toHaveLength(11)
      expect(inventory.networks()).toHaveLength(16)
      expect(inventory.egresses()).toHaveLength(11)
      expect(inventory.routes()).toHaveLength(20)
      expect(inventory.clients()).toHaveLength(35)
      expect(inventory.wlans()).toHaveLength(3)
      expect(inventory.dashboard().throughput).toHaveLength(1)
      const changed = inventory.updateEgress('demo-wan-1', { color: '#123456', probeEnabled: true }, ctx)
      expect(changed).toMatchObject({ color: '#123456', probe: { enabled: true } })
      await service.setMode('dry-run', ctx)
      const dry = await service.probe(ctx)
      const routeChecks = (status: typeof dry) => status.capabilities.filter(entry =>
        ['routes.create', 'routes.update', 'routes.delete'].includes(entry.key)).map(entry => entry.status)
      expect(routeChecks(dry)).toEqual(['skipped', 'skipped', 'skipped'])
      expect(dry.capabilities).toHaveLength(18)
      await service.setMode('live', ctx)
      const live = await service.probe(ctx)
      expect(routeChecks(live)).toEqual(['ok', 'ok', 'ok'])
      expect(await service.runtime?.api.routes()).toHaveLength(20)
      const client = inventory.clients({ online: true }).find(client => client.mac !== SELF_MAC)!
      expect(inventory.updateClient(client.mac, { alias: 'Lab test', note: 'Fixture' }, ctx)).toMatchObject({ displayName: 'Lab test' })
      await expect(inventory.clientAction(client.mac, { action: 'block', minutes: 1 }, ctx)).resolves.toMatchObject({ blocked: true })
      const reason = db.select().from(blocks).get()!
      expect(reason).toMatchObject({ mac: client.mac, source: 'manual', applied: true })
      await inventory.expireManualBlocks(reason.until!)
      expect(inventory.client(client.mac).blocked).toBe(false)
      expect(db.select().from(blocks).all()).toHaveLength(0)
      expect(inventory.egresses().find(egress => egress.id === changed.id)?.color).toBe('#123456')
    } finally {
      await service.stop()
      sqlite.close()
    }
  })
})
