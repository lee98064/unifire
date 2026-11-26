import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GroupInput, MeSummary, PersonInput, QuotaInput } from '../../shared/schemas/access'
import { createDatabase } from '../../server/db'
import { initialSql } from '../../server/db/migrations/0001-initial'
import { routingSql } from '../../server/db/migrations/0002-routing'
import { snapshotsSql } from '../../server/db/migrations/0003-snapshots'
import { migrateDatabase } from '../../server/db/migrations'
import { clients, presenceSessions, quotaRoutes, usageMinutes } from '../../server/db/schema'
import { DAY, MINUTE, bedtimeWindows, quotaPeriod } from '../../server/engine/access-time'
import { createBlockReconciler, desiredBlocks, ownedBlocks } from '../../server/engine/blocks'
import { updatePresence } from '../../server/engine/presence'
import { createQuotaRoutes } from '../../server/engine/quota-routes'
import { createUsageSampler, createUsageStore } from '../../server/engine/samplers/usage'
import { createAccess } from '../../server/services/access'
import { createClientSync } from '../../server/services/client-sync'
import { createControllerService, systemContext, type ControllerService } from '../../server/services/controller'
import { createExtensions } from '../../server/services/extensions'
import { createInventory } from '../../server/services/inventory'
import { createPeopleService } from '../../server/services/people'
import { createQuotaService } from '../../server/services/quotas'
import { createSettingsService } from '../../server/services/settings'
import { createUnifiTransport } from '../../server/unifi/client'
import { inspectCertificate } from '../../server/unifi/tls'
import { startMockController } from '../../server/unifi/mock'
import type { ControllerEvent } from '../../server/unifi/ws'
import { canReceiveEvent, createLiveBus } from '../../server/utils/bus'
import { initializeCrypto } from '../../server/utils/crypto'

const mac1 = '00:11:22:33:44:51'
const mac2 = '00:11:22:33:44:52'
const mac3 = '02:11:22:33:44:53'
const friday = Date.UTC(2026, 10, 27, 12)
const admin = { id: 'test-admin', username: 'test-admin' }

it('migrates WP2 approvals using the first sync and leaves unproven block ownership empty', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(initialSql)
    sqlite.exec(routingSql)
    sqlite.exec(snapshotsSql)
    sqlite.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO _migrations VALUES (1, 1), (2, 2), (3, 3);
      INSERT INTO controller (id, url, site, username, encrypted_password, verify_mode, mode)
        VALUES (1, 'https://gateway.example', 'default', 'user', 'fixture', 'fingerprint', 'dry-run');
      INSERT INTO clients (mac, approval, first_seen, detected_at)
        VALUES ('${mac1}', 'pending', 90, 100), ('${mac2}', 'pending', 105, 120);
      INSERT INTO blocks (id, mac, source, label, applied) VALUES ('legacy', '${mac1}', 'manual', 'block.manual', 1);
    `)
    migrateDatabase(sqlite)
    expect(sqlite.prepare('SELECT approval FROM clients ORDER BY mac').pluck().all()).toEqual(['approved', 'pending'])
    expect(JSON.parse(sqlite.prepare("SELECT value FROM settings WHERE key = 'access.clientBaseline'").pluck().get() as string))
      .toEqual(JSON.stringify(['https://gateway.example', 'default']))
    expect(sqlite.prepare('SELECT * FROM applied_client_blocks').all()).toEqual([])
    expect(sqlite.prepare('SELECT source, applied FROM blocks').all()).toEqual([{ source: 'manual', applied: 0 }])
  } finally { sqlite.close() }
})

describe('WP5 access accounting', () => {
  let database: ReturnType<typeof createDatabase>
  let at: number
  let engine: EventEmitter<{ event: [ControllerEvent] }>
  let events: ControllerEvent[]
  let people: ReturnType<typeof createPeopleService>
  let quotas: ReturnType<typeof createQuotaService>
  let usage: ReturnType<typeof createUsageStore>
  let extensions: ReturnType<typeof createExtensions>

  beforeEach(() => {
    database = createDatabase()
    at = friday
    engine = new EventEmitter()
    events = []
    engine.on('event', event => events.push(event))
    people = createPeopleService(database.db, engine, () => at)
    quotas = createQuotaService(database.db, engine)
    usage = createUsageStore(database.db)
    extensions = createExtensions(database.db, engine, people, quotas, () => 'Asia/Taipei', () => at)
  })

  afterEach(() => database.sqlite.close())

  function person(name: string, devices = [mac1]) {
    for (const mac of devices) database.db.insert(clients).values({ mac, approval: 'approved' }).onConflictDoNothing().run()
    return people.create(PersonInput.parse({ name, color: '#123456', deviceMacs: devices }))
  }

  function createQuota(scopeId: string, input: Partial<ReturnType<typeof QuotaInput.parse>> = {}) {
    return quotas.create(QuotaInput.parse({ name: 'Time', scope: { type: 'person', id: scopeId }, metric: 'activeMinutes',
      period: 'daily', limit: 5, weekdayLimits: null, action: { type: 'block' }, enabled: true, ...input }))
  }

  it('baselines only after both inventories and audits a randomized hostname match on subsequent syncs', () => {
    const bus = createLiveBus()
    const notices: string[] = []
    bus.subscribe(event => notices.push(event.type))
    const sync = createClientSync(database.db, 'controller-1', engine, bus)
    expect(sync([{ mac: mac1, hostname: 'Laptop' }], true, at)).toBe(false)
    expect(database.db.select().from(clients).all()).toEqual([])
    expect(sync([{ mac: mac2, hostname: 'Tablet' }], false, at)).toBe(true)
    expect(database.db.select().from(clients).all().map(row => row.approval)).toEqual(['approved', 'approved'])
    expect(notices).toEqual([])
    createClientSync(database.db, 'controller-1', engine, bus)([{ mac: mac3, hostname: ' laptop ' }], true, at + MINUTE)
    expect(database.db.select().from(clients).where(eq(clients.mac, mac3)).get()?.approval).toBe('approved')
    expect(notices).toEqual(['audit'])

    const newcomer = '10:11:22:33:44:54'
    sync([{ mac: newcomer }], true, at + MINUTE)
    expect(database.db.select().from(clients).where(eq(clients.mac, newcomer)).get()).toMatchObject({
      approval: 'pending', detectedAt: at + MINUTE,
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'client.new', mac: newcomer }),
      expect.objectContaining({ type: 'notification', event: 'new_device', mac: newcomer }),
    ]))
    expect(notices).toContain('approval.new')
    const baselineOther = createClientSync(database.db, 'controller-2', engine, bus)
    baselineOther([{ mac: newcomer }], false, at + 2 * MINUTE)
    baselineOther([], true, at + 2 * MINUTE)
    expect(database.db.select().from(clients).where(eq(clients.mac, newcomer)).get()?.approval).toBe('approved')
  })

  it('handles reset counters, inclusive activity, excessive deltas, and gaps', () => {
    const sample = createUsageSampler()
    const station = (rx: number, tx: number) => [{ mac: mac1, rx_bytes: rx, tx_bytes: tx }]
    expect(sample(station(1000, 400), at, 100)).toEqual([])
    expect(sample(station(75, 425), at + MINUTE, 100)).toEqual([{ mac: mac1, ts: at, rxBytes: 75, txBytes: 25, active: true }])
    expect(sample(station(80_000_000_000, 450), at + 2 * MINUTE, 100)).toEqual([])
    expect(sample(station(80_000_000_005, 460), at + 3 * MINUTE, 100)).toEqual([
      { mac: mac1, ts: at + 2 * MINUTE, rxBytes: 5, txBytes: 10, active: false },
    ])
    expect(sample(station(80_000_000_050, 550), at + 6 * MINUTE, 100)).toEqual([])
  })

  it('counts active minutes as a union after raw retention and keeps the rollups idempotent', () => {
    const subject = person('Alex', [mac1, mac2])
    const rows = [
      { mac: mac1, ts: at, rxBytes: 200, txBytes: 50, active: true },
      { mac: mac2, ts: at, rxBytes: 100, txBytes: 10, active: true },
      { mac: mac2, ts: at + MINUTE, rxBytes: 65, txBytes: 5, active: true },
    ]
    const quota = createQuota(subject.id, { period: 'monthly' })
    usage.record(rows, 'Asia/Taipei')
    usage.record(rows, 'Asia/Taipei')
    usage.prune(at + 3 * DAY, 1)
    usage.record(rows, 'Asia/Taipei')
    expect(database.db.select().from(usageMinutes).all()).toEqual([])
    expect(usage.forMacs([mac1, mac2], at, at + DAY)).toEqual({ rxBytes: 365, txBytes: 65, activeMinutes: 2 })
    expect(quotas.evaluate(people.rows(), at + DAY, 'Asia/Taipei', [quota])[0]?.status.used).toBe(2)
    expect(usage.history(mac2, '24h', at + MINUTE, 'Asia/Taipei').totals.activeMinutes).toBe(2)
    expect(usage.history(mac2, '7d', at + DAY, 'Asia/Kathmandu').totals.rxBytes).toBe(165)
  })

  it('uses local weekly and monthly boundaries, DST and Monday-based weekday limits', () => {
    expect(quotaPeriod(friday, 'Asia/Taipei', 'weekly')).toEqual({
      start: Date.UTC(2026, 10, 22, 16), end: Date.UTC(2026, 10, 29, 16), day: 4,
    })
    expect(quotaPeriod(friday, 'Asia/Kathmandu', 'monthly')).toEqual({
      start: Date.UTC(2026, 9, 31, 18, 15), end: Date.UTC(2026, 10, 30, 18, 15), day: 4,
    })
    const dst = quotaPeriod(Date.UTC(2026, 2, 8, 15), 'America/New_York', 'daily')
    expect(dst.end - dst.start).toBe(23 * 60 * MINUTE)
    const subject = person('Alex')
    const quota = createQuota(subject.id, { weekdayLimits: [null, null, null, null, null, 10, 10] })
    expect(quotas.evaluate(people.rows(), friday, 'Asia/Taipei', [quota])[0]?.status.limit).toBe(5)
    expect(quotas.evaluate(people.rows(), friday + DAY, 'Asia/Taipei', [quota])[0]?.status.limit).toBe(10)
  })

  it('suppresses pause, bedtime and quota with allowance while preserving other reasons', () => {
    const subject = person('Alex')
    const group = people.groupCreate(GroupInput.parse({ name: 'Family', color: '#123456', personIds: [subject.id] }))
    people.pause(subject.id, { minutes: null })
    people.groupPause(group.id, { minutes: 30 })
    people.groupPause(group.id, null)
    expect(people.get(subject.id).pause.active).toBe(true)
    const weekday = { days: [4], start: '22:00', end: '07:00', enabled: true }
    people.update(subject.id, { bedtime: [weekday] })
    at = Date.UTC(2026, 10, 27, 17)
    expect(bedtimeWindows([weekday], at, 'Asia/Taipei')).toEqual([
      { start: Date.UTC(2026, 10, 27, 14), end: Date.UTC(2026, 10, 27, 23) },
    ])
    database.db.update(clients).set({ approval: 'pending' }).where(eq(clients.mac, mac1)).run()
    database.sqlite.prepare("INSERT INTO blocks (id, mac, source, label) VALUES ('manual', ?, 'manual', 'block.manual'), ('rule', ?, 'rule', 'block.rule')").run(mac1, mac1)
    createQuota(subject.id, { limit: 1 })
    usage.record([{ mac: mac1, ts: at - MINUTE, rxBytes: 100, txBytes: 10, active: true }], 'Asia/Taipei')
    const reasons = () => desiredBlocks(database.db, people.rows(), quotas.evaluate(people.rows(), at, 'Asia/Taipei'),
      at, 'Asia/Taipei', true).get(mac1)?.map(row => row.source)
    expect(reasons()).toEqual(['manual', 'rule', 'approval', 'pause', 'bedtime', 'quota'])
    people.allow(subject.id, 30)
    expect(reasons()).toEqual(['manual', 'rule', 'approval'])
  })

  it('tracks presence across both devices and only leaves after the grace period', () => {
    const subject = person('Alex', [mac1, mac2])
    people.update(subject.id, { presenceMacs: [mac1, mac2] })
    const check = (macs: string[], minutes: number) =>
      updatePresence(database.db, engine, people.rows(), new Set(macs), at + minutes * MINUTE, 3)
    check([mac1], 0)
    check([], 1)
    check([mac2], 2)
    check([], 3)
    check([], 5)
    expect(people.get(subject.id).presence.home).toBe(true)
    check([], 6)
    expect(people.get(subject.id).presence).toEqual({ home: false, since: at + 6 * MINUTE })
    expect(events.filter(event => ['person.arrived', 'person.left'].includes(event.type)).map(event => event.type))
      .toEqual(['person.arrived', 'person.left'])
    expect(database.db.select().from(presenceSessions).all()).toHaveLength(1)
  })

  it('limits requests to one pending, grants current-period bonus and allowance, and scopes access', () => {
    const alex = person('Alex')
    const sam = person('Sam', [mac2])
    const active = createQuota(alex.id, { limit: 1 })
    const foreign = createQuota(sam.id)
    const request = extensions.create(alex.id, { quotaId: active.id, amount: 5 })
    expect(() => extensions.create(alex.id, { quotaId: null, amount: 10 })).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(() => extensions.create(sam.id, { quotaId: active.id, amount: 10 })).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(extensions.decide(request.id, { decision: 'approve', amount: 15 }, admin)).toMatchObject({ amount: 15, status: 'approved' })
    expect(quotas.evaluate(people.rows(), at, 'Asia/Taipei', [active])[0]?.status.bonus).toBe(15)
    const allowance = extensions.create(alex.id, { quotaId: null, amount: 20 })
    extensions.decide(allowance.id, { decision: 'approve' }, admin)
    expect(people.get(alex.id).allowanceUntil).toBe(at + 20 * MINUTE)
    const expired = extensions.create(alex.id, { quotaId: active.id, amount: 5 })
    extensions.create(sam.id, { quotaId: foreign.id, amount: 5 })
    at = quotaPeriod(at, 'Asia/Taipei', 'daily').end
    expect(extensions.list('expired', alex.id).map(row => row.id)).toEqual([expired.id])
    expect(quotas.evaluate(people.rows(), at, 'Asia/Taipei', [active])[0]?.status.bonus).toBe(0)
    expect(canReceiveEvent({ role: 'member', personId: sam.id },
      { type: 'extension.request', data: { requestId: request.id, personId: alex.id } })).toBe(false)
  })

  it('emits warning and exceeded once per period and separates group members', () => {
    const alex = person('Alex')
    const sam = person('Sam', [mac2])
    const group = people.groupCreate(GroupInput.parse({ name: 'Family', color: '#123456', personIds: [alex.id, sam.id] }))
    createQuota(group.id, { scope: { type: 'group', id: group.id }, limit: 100, metric: 'bytes' })
    const tick = () => quotas.transitions(quotas.evaluate(people.rows(), at, 'Asia/Taipei'))
    usage.record([{ mac: mac1, ts: at - 2 * MINUTE, rxBytes: 80, txBytes: 0, active: false }], 'Asia/Taipei')
    tick()
    tick()
    usage.record([{ mac: mac1, ts: at - MINUTE, rxBytes: 20, txBytes: 0, active: false }], 'Asia/Taipei')
    tick()
    tick()
    expect(events.filter(event => event.type === 'quota.warning' || event.type === 'quota.exceeded')).toEqual([
      expect.objectContaining({ type: 'quota.warning', personId: alex.id }),
      expect.objectContaining({ type: 'quota.exceeded', personId: alex.id }),
    ])
  })
})

describe('WP5 controller enforcement', () => {
  let database: ReturnType<typeof createDatabase>
  let service: ControllerService
  let fake: Awaited<ReturnType<typeof startMockController>>

  beforeEach(async () => {
    database = createDatabase()
    initializeCrypto(Buffer.alloc(32, 55))
    fake = await startMockController({ tls: {
      key: readFileSync(new URL('./fixtures/wp2-test-key.pem', import.meta.url)),
      cert: readFileSync(new URL('./fixtures/wp2-test-cert.pem', import.meta.url)),
    } })
    service = await createControllerService(database.db, { mock: false })
    const { fingerprint } = await inspectCertificate(fake.config.url)
    await service.save({ ...fake.config, verifyMode: 'fingerprint', fingerprint }, systemContext)
    await service.setMode('live', systemContext)
    await service.probe(systemContext)
  })

  afterEach(async () => {
    await service.stop()
    await fake.close()
    database.sqlite.close()
  })

  it('keeps foreign blocks, honors dry run, and releases only its verified own blocks', async () => {
    const { db } = database
    const runtime = service.runtime!
    const inventory = createInventory(db, service)
    const [foreign, ours] = inventory.clients({ online: true }).map(row => row.mac)
    const outsider = createUnifiTransport(runtime.config, { mock: true })
    try { await outsider.write('POST', fake.paths.classic('cmd/stamgr'), { cmd: 'block-sta', mac: foreign }) }
    finally { await outsider.close() }
    await service.sync()
    const reconciler = createBlockReconciler(db, service)
    const reasons = new Map([foreign!, ours!].map(mac => [mac, [{ source: 'manual' as const, refId: null, label: 'block.manual', until: null }]]))
    const count = fake.mutationCount
    await service.setMode('dry-run', systemContext)
    await reconciler.reconcile(() => reasons)
    expect(fake.mutationCount).toBe(count)
    expect(ownedBlocks(db, runtime.scope).size).toBe(0)
    await service.setMode('live', systemContext)
    await reconciler.reconcile(() => reasons)
    expect(ownedBlocks(db, runtime.scope)).toEqual(new Set([ours]))
    await reconciler.reconcile(() => new Map())
    expect(inventory.client(ours!).blocked).toBe(false)
    expect(inventory.client(foreign!)).toMatchObject({ blocked: true, blockReasons: [{ source: 'unifi' }] })
    expect(fake.mutationCount).toBe(count + 2)
  })

  it('turns strict quarantine into a persistent manual block or releases it on approval or ignore', async () => {
    const { db } = database
    const access = createAccess(db, service)
    const inventory = createInventory(db, service, undefined, access)
    const sample = inventory.clients({ online: true }).slice(1, 4)
    createSettingsService(db).patch({ approval: { mode: 'strict', matchRandomizedByHostname: true } })
    for (const { mac } of sample) db.update(clients).set({ approval: 'pending', detectedAt: Date.now() }).where(eq(clients.mac, mac)).run()
    await access.blocks.reconcile(access.desired)
    expect(inventory.approvals().filter(item => item.quarantined)).toHaveLength(3)
    await access.approval(sample[0]!.mac, { decision: 'approve', alias: 'Trusted' }, systemContext)
    await access.approval(sample[1]!.mac, { decision: 'ignore' }, systemContext)
    await access.approval(sample[2]!.mac, { decision: 'block' }, systemContext)
    expect(inventory.client(sample[0]!.mac)).toMatchObject({ approval: 'approved', blocked: false, displayName: 'Trusted' })
    expect(inventory.client(sample[1]!.mac)).toMatchObject({ approval: 'ignored', blocked: false, blockReasons: [] })
    expect(inventory.client(sample[2]!.mac)).toMatchObject({ approval: 'blocked', blocked: true, blockReasons: [{ source: 'manual' }] })
  })

  it('builds and disables a scoped quota route through the gate and isolates member data', async () => {
    const { db } = database
    let at = friday
    const access = createAccess(db, service, () => at)
    const inventory = createInventory(db, service, undefined, access)
    const [own, other] = inventory.clients({ online: true }).slice(1, 3).map(row => row.mac)
    const subject = access.people.create(PersonInput.parse({ name: 'Alex', color: '#123456', deviceMacs: [own] }))
    const unrelated = access.people.create(PersonInput.parse({ name: 'Sam', color: '#123456', deviceMacs: [other] }))
    const exit = 'demo-wan-2'
    const rule = access.quotas.create(QuotaInput.parse({
      name: 'Limit', scope: { type: 'person', id: subject.id }, metric: 'activeMinutes',
      period: 'daily', limit: 1, weekdayLimits: null, action: { type: 'egress', egressId: exit }, enabled: true,
    }))
    access.extensions.create(unrelated.id, { quotaId: null, amount: 15 })
    access.usage.record([{ mac: own!, ts: at - MINUTE, rxBytes: 100, txBytes: 5, active: true }], 'Asia/Taipei')
    const settings = createSettingsService(db)
    const turn = createQuotaRoutes(db, service)
    const reconcile = () => turn(access.quotaStatuses(), access.people.rows())
    await reconcile()
    const row = db.select().from(quotaRoutes).get()!
    const route = async () => (await service.runtime!.api.routes()).find(doc => doc._id === row.routeId)
    expect(await route()).toMatchObject({ enabled: true, network_id: exit, description: '[unifire-quota] Alex',
      target_devices: [{ type: 'CLIENT', client_mac: own }] })
    expect(service.ownership('default').quotaRoutes.has(row.routeId)).toBe(true)
    expect(MeSummary.parse(access.summary(subject.id, inventory.clients))).toMatchObject({
      person: { id: subject.id }, devices: [{ mac: own }], quotas: [{ quotaId: rule.id, state: 'exceeded' }], requests: [],
    })
    at = quotaPeriod(at, settings.get().timezone, 'daily').end
    await reconcile()
    expect(await route()).toMatchObject({ enabled: false })
  })
})
