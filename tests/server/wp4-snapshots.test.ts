import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestoreInput, SnapshotResource } from '../../shared/schemas/insight'
import type { SnapshotResourceT } from '../../shared/schemas/insight'
import { createDatabase } from '../../server/db'
import { managedRoutes, snapshotItems, unifiLogEntries } from '../../server/db/schema'
import { createAuditWatch } from '../../server/engine/audit-watch'
import { createSnapshots } from '../../server/engine/snapshots'
import { indexCollection } from '../../server/engine/snapshots/capture'
import { digest, fieldDiff, labelResolver, type Collections } from '../../server/engine/snapshots/diff'
import { restoreReason } from '../../server/engine/snapshots/restore'
import { createSnapshotStore, DAY } from '../../server/engine/snapshots/store'
import { createAuditService } from '../../server/services/audit'
import { createControllerService, systemContext } from '../../server/services/controller'
import { routeFingerprint } from '../../server/services/ownership'
import { createSettingsService } from '../../server/services/settings'
import { createUnifiTransport } from '../../server/unifi/client'
import { DEMO_ROUTES } from '../../server/unifi/mock/fixtures'
import type { WireDoc } from '../../server/unifi/endpoints/schemas'
import { readCollection, resourcePath } from '../../server/unifi/snapshot-resources'
import type { ControllerEvent } from '../../server/unifi/ws'
import { initializeCrypto } from '../../server/utils/crypto'

const ctx = systemContext

it('normalizes counters and key order, retains array order, and resolves recursive diff labels', () => {
  const oldCollections: Collections = new Map()
  oldCollections.set('networkconf', indexCollection('networkconf', [{ _id: 'wan', name: 'Fiber' }]))
  oldCollections.set('users', indexCollection('users', [{ _id: 'client', mac: 'a', hostname: 'Phone' }]))
  oldCollections.set('firewall-zones', indexCollection('firewall-zones', [{ _id: 'home', name: 'Home' }]))
  const newCollections: Collections = new Map()
  newCollections.set('networkconf', indexCollection('networkconf', [{ _id: 'vpn', name: 'Tokyo' }]))
  newCollections.set('users', indexCollection('users', [{ _id: 'client2', mac: 'b', hostname: 'Tablet' }]))
  newCollections.set('wlanconf', indexCollection('wlanconf', [{ _id: 'wifi', name: 'Guest' }]))
  const old = { network_id: 'wan', target_devices: [{ client_mac: 'a' }], source: { zone_id: 'home' },
    x_nested: { passphrase: 'secret-one' }, packet_count: 10 }
  const current = { network_id: 'vpn', target_devices: [{ client_mac: 'b' }], wlan_id: 'wifi',
    x_nested: { passphrase: 'secret-two' }, packet_count: 99 }
  expect(fieldDiff(old, current, labelResolver(oldCollections), labelResolver(newCollections))).toEqual([
    { path: 'network_id', before: 'wan', after: 'vpn', beforeLabel: 'Fiber', afterLabel: 'Tokyo', secret: false },
    { path: 'source.zone_id', before: 'home', after: null, beforeLabel: 'Home', afterLabel: null, secret: false },
    { path: 'target_devices[0].client_mac', before: 'a', after: 'b', beforeLabel: 'Phone', afterLabel: 'Tablet', secret: false },
    { path: 'x_nested', before: null, after: null, beforeLabel: null, afterLabel: null, secret: true },
    { path: 'wlan_id', before: null, after: 'wifi', beforeLabel: null, afterLabel: 'Guest', secret: false },
  ])
  expect(digest({ z: 1, a: { updated_at: 1, index: 2 } })).toBe(digest({ a: { index: 2 }, z: 1 }))
  expect(digest([1, 2])).not.toBe(digest([2, 1]))
  expect(fieldDiff({ rule_index: 1 }, { rule_index: 2 })).toMatchObject([{ path: 'rule_index', after: 2 }])
})

describe('WP4 snapshots and audit with fake UniFi', () => {
  let database: ReturnType<typeof createDatabase>
  let service: Awaited<ReturnType<typeof createControllerService>>
  let external: ReturnType<typeof createUnifiTransport>
  let snapshots: ReturnType<typeof createSnapshots>
  let runtime: NonNullable<typeof service.runtime>
  let at: number

  beforeEach(async () => {
    database = createDatabase()
    initializeCrypto(Buffer.alloc(32, 41))
    service = await createControllerService(database.db, { mock: true })
    await service.ready()
    runtime = service.runtime!
    external = createUnifiTransport(runtime.config, { mock: true })
    at = Date.now()
    snapshots = createSnapshots(database.db, service, () => at)
  })

  afterEach(async () => {
    await external.close()
    await service.stop()
    database.sqlite.close()
  })

  async function document(resource: SnapshotResourceT, id: string) {
    const found = (await readCollection(runtime.api, resource)).find(doc => doc._id === id || doc.id === id)
    expect(found).toBeDefined()
    return found!
  }

  async function edit(resource: SnapshotResourceT, id: string, patch: WireDoc) {
    return external.write('PUT', resourcePath(external.paths, resource, id), { ...await document(resource, id), ...patch })
  }

  function apply(snapshotId: string, items: [SnapshotResourceT, string][], dryRun?: boolean) {
    return snapshots.apply(snapshotId, RestoreInput.parse({ items: items.map(([resource, itemId]) => ({ resource, itemId })), dryRun }), ctx)
  }

  it('captures all collections, encrypts full documents, diffs live state in memory and paginates stored state', async () => {
    const original = await snapshots.create('baseline', ctx)
    expect(original).toMatchObject({ complete: true, failed: [], networkVersion: '11.0.99', trigger: 'manual', changeCount: null })
    expect(Object.keys(original.counts)).toEqual(SnapshotResource.options)
    expect(original.sizeBytes).toBeGreaterThan(0)
    const stored = database.db.select().from(snapshotItems).where(eq(snapshotItems.itemId, 'demo-wlan-0')).get()!
    expect(stored.encryptedDoc).toMatch(/^v1\./)
    expect(stored.encryptedDoc).not.toContain('fixture-only')
    const item = snapshots.item(original.id, 'wlanconf', 'demo-wlan-0')
    expect(item.doc.x_passphrase).toBeNull()

    await edit('trafficroutes', DEMO_ROUTES.nas, { network_id: 'demo-vpn-1' })
    await edit('wlanconf', 'demo-wlan-0', { x_passphrase: 'new-fixture-password' })
    const live = await snapshots.diff(original.id)
    expect(live.toId).toBeNull()
    expect(live.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'trafficroutes', restorable: true, summaryKey: 'snapshots.summary.routeEgress',
        fields: [expect.objectContaining({ path: 'network_id', beforeLabel: expect.any(String), afterLabel: expect.any(String) })] }),
      expect.objectContaining({ resource: 'wlanconf', summaryKey: 'snapshots.summary.wifiPassword',
        fields: [expect.objectContaining({ path: 'x_passphrase', before: null, after: null, secret: true })] }),
    ]))
    expect(JSON.stringify(live)).not.toContain('new-fixture-password')
    expect(snapshots.list({ limit: 20 }).items).toHaveLength(1)
    at++
    const updated = await snapshots.create(undefined, ctx)
    expect(updated.changeCount).toBe(2)
    const page = snapshots.list({ limit: 1 })
    expect(page.items).toEqual([updated])
    expect(snapshots.list({ cursor: page.nextCursor!, limit: 1 }).items).toEqual([original])
    expect((await snapshots.diff(original.id, updated.id)).changes).toEqual(live.changes)
    expect(snapshots.remove(updated.id, ctx)).toEqual({ ok: true })
    expect(() => snapshots.item(updated.id, 'wlanconf', 'demo-wlan-0')).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(database.db.select().from(snapshotItems).where(eq(snapshotItems.snapshotId, updated.id)).all()).toEqual([])
  })

  it('skips unread collections for diffs and restores, and protects the newest three during retention', async () => {
    const store = createSnapshotStore(database.db)
    const original = await snapshots.create(undefined, ctx)
    const originalRead = runtime.api.configCollection
    const failing = vi.spyOn(runtime.api, 'configCollection').mockImplementation((name, v2) =>
      name === 'static-dns' ? Promise.reject(new Error('offline')) : originalRead(name, v2))
    at++
    const partial = await snapshots.create(undefined, ctx)
    expect(partial).toMatchObject({ complete: false, failed: ['static-dns'], changeCount: 0 })
    expect(await snapshots.diff(original.id, partial.id)).toMatchObject({ changes: [], unavailableResources: ['static-dns'] })
    expect(await snapshots.diff(original.id)).toMatchObject({ changes: [], unavailableResources: ['static-dns'] })
    expect((await apply(partial.id, [['static-dns', 'demo-dns']])).steps).toMatchObject([{ supported: false, reason: 'incomplete' }])
    failing.mockRestore()
    for (let i = 0; i < 3; i++) {
      at += DAY
      await snapshots.create(undefined, ctx)
    }
    store.prune(at + DAY)
    expect(snapshots.list({ limit: 10 }).items).toHaveLength(3)
    expect(snapshots.list({ limit: 10 }).items.at(-1)?.ts).toBe(at - 2 * DAY)
  })

  it('plans each resource with ownership rules and applies only supported steps with read-back', async () => {
    const original = await snapshots.create(undefined, ctx)
    const nas = DEMO_ROUTES.nas
    const probe = await runtime.writes.createRoute({ ...await document('trafficroutes', nas), description: '[unifire-probe] test' }, ctx)
    await edit('trafficroutes', nas, { kill_switch_enabled: false, new_controller_field: 'preserved' })
    await edit('trafficroutes', DEMO_ROUTES.external, { enabled: false })
    await edit('objects', 'demo-object-0', { enabled: false })
    await edit('firewall-policies', 'demo-policy', { enabled: false })
    await edit('wlanconf', 'demo-wlan-0', { x_passphrase: 'changed-fixture', enabled: false })
    await edit('users', 'demo-client-0', { name: 'Renamed', blocked: true })
    await external.write('DELETE', resourcePath(external.paths, 'portforward', 'demo-forward'))
    await external.write('POST', resourcePath(external.paths, 'portforward'), { name: 'New forward', enabled: false })
    const added = (await runtime.api.portForwards()).find(doc => doc.name === 'New forward')!
    // An external change can replace the record behind the same fixture id.
    const read = runtime.api.configCollection
    const dns = vi.spyOn(runtime.api, 'configCollection').mockImplementation(async (path, v2) => {
      const docs = await read(path, v2)
      return path === 'static-dns' ? docs.map(doc => doc._id === 'demo-dns' ? { ...doc, value: '10.235.0.88' } : doc) : docs
    })
    const selections: [SnapshotResourceT, string][] = [
      ['trafficroutes', nas], ['trafficroutes', DEMO_ROUTES.external], ['trafficroutes', probe.id!],
      ['trafficroutes', 'demo-route-17'], ['trafficroutes', 'demo-route-20'], ['trafficroutes', 'demo-route-1'],
      ['objects', 'demo-object-0'], ['firewall-policies', 'demo-policy'], ['wlanconf', 'demo-wlan-0'],
      ['users', 'demo-client-0'], ['portforward', 'demo-forward'], ['portforward', added._id as string],
      ['static-dns', 'demo-dns'], ['networkconf', 'demo-wan-1'], ['firewall-zones', 'demo-zone-core'],
      ['routing', 'missing'], ['qos-rules', 'missing'], ['portconf', 'demo-port-poe'],
    ]
    const preview = await apply(original.id, selections)
    expect(preview.dryRun).toBe(true)
    expect(preview.steps.map(step => [step.resource, step.method, step.reason])).toEqual([
      ['trafficroutes', 'PUT', null], ['trafficroutes', 'PUT', 'excluded'], ['trafficroutes', 'DELETE', 'excluded'],
      ['trafficroutes', 'PUT', 'notOwned'], ['trafficroutes', 'PUT', 'notOwned'], ['trafficroutes', 'PUT', 'notOwned'],
      ['objects', 'PUT', null], ['firewall-policies', 'PUT', null], ['wlanconf', 'PUT', null], ['users', 'PUT', null],
      ['portforward', 'POST', null], ['portforward', 'DELETE', null], ['static-dns', 'DELETE', null], ['static-dns', 'POST', null],
      ['networkconf', 'PUT', 'unsupported'], ['firewall-zones', 'PUT', 'unsupported'], ['routing', 'DELETE', 'unsupported'],
      ['qos-rules', 'DELETE', 'unsupported'], ['portconf', 'PUT', 'unsupported'],
    ])
    expect(preview.steps[6]?.path).toContain('/object-oriented-network-config/demo-object-0')
    expect(preview.steps[8]?.body?.x_passphrase).toBeNull()
    expect(preview.steps[13]?.body?.key).toBeNull()
    expect((await document('wlanconf', 'demo-wlan-0')).x_passphrase).toBe('changed-fixture')

    await service.setMode('dry-run', ctx)
    const dry = await apply(original.id, selections, false)
    expect(dry.dryRun).toBe(false)
    expect(dry.steps.every(step => step.result === 'skipped')).toBe(true)
    expect((await document('trafficroutes', nas)).kill_switch_enabled).toBe(false)
    await service.setMode('live', ctx)
    const live = await apply(original.id, selections, false)
    expect(live.dryRun).toBe(false)
    expect(live.steps.filter(step => step.supported).map(step => step.result)).toEqual(Array(9).fill('applied'))
    dns.mockRestore()
    expect(await document('trafficroutes', nas)).toMatchObject({ kill_switch_enabled: true, new_controller_field: 'preserved' })
    expect(await document('users', 'demo-client-0')).toMatchObject({ name: 'Unifire demo host', blocked: true })
    expect((await document('wlanconf', 'demo-wlan-0')).x_passphrase).toBe('fixture-only')
    expect((await runtime.api.staticDns())[0]?.value).toBe('10.235.0.25')
    const baseline = database.db.select().from(managedRoutes).where(eq(managedRoutes.unifiRouteId, nas)).get()
    expect(baseline?.baselineFingerprint).toBe(routeFingerprint((await runtime.api.routes()).find(doc => doc._id === nas)!))
    expect(snapshots.list({ limit: 20 }).items.filter(row => row.trigger === 'pre-restore')).toHaveLength(2)
    expect((await apply(original.id, [['static-dns', 'demo-dns'], ['portforward', 'demo-forward']])).steps)
      .toMatchObject([{ reason: 'unchanged' }, { reason: 'unchanged' }])
    const replacement = (await runtime.api.staticDns())[0]!._id as string
    expect((await apply(original.id, [['static-dns', replacement]])).steps).toMatchObject([{ reason: 'replacement' }])
    expect((await snapshots.diff(original.id)).changes.find(change => change.itemId === replacement)?.restorable).toBe(false)
  })

  it('reports verification failure, recreates adopted routes safely and rebinds their identities', async () => {
    const original = await snapshots.create(undefined, ctx)
    const id = DEMO_ROUTES.nas
    await external.write('DELETE', resourcePath(external.paths, 'trafficroutes', id))
    expect((await apply(original.id, [['trafficroutes', id]], false)).steps).toMatchObject([{ method: 'POST', result: 'applied' }])
    const rebound = database.db.select().from(managedRoutes).where(eq(managedRoutes.id, 'demo-managed-nas')).get()
    expect(rebound?.unifiRouteId).not.toBe(id)
    expect((await apply(original.id, [['trafficroutes', id]])).steps).toMatchObject([{ reason: 'unchanged' }])

    await edit('wlanconf', 'demo-wlan-0', { enabled: false })
    const originalRead = runtime.api.configCollection
    const spy = vi.spyOn(runtime.api, 'configCollection').mockImplementation(async (name, v2) => {
      const docs = await originalRead(name, v2)
      return name === 'rest/wlanconf' ? docs.map(doc => doc._id === 'demo-wlan-0' ? { ...doc, enabled: false } : doc) : docs
    })
    expect((await apply(original.id, [['wlanconf', 'demo-wlan-0']], false)).steps)
      .toMatchObject([{ result: 'failed', error: 'UNIFI_VERIFY_FAILED' }])
    spy.mockRestore()
    expect(createAuditService(database.db).list({ category: 'snapshot', q: 'UNIFI_VERIFY_FAILED' }).items).toHaveLength(1)
  })

  it('reuses recent pre-write snapshots and distinguishes own writes from external changes', async () => {
    const watch = createAuditWatch(database.db, service)
    const starter = snapshots.start()
    try {
      await starter.ready
      await watch.fingerprint()
      const id = DEMO_ROUTES.nas
      await runtime.writes.updateRouteEgress(id, 'demo-vpn-1', ctx)
      await runtime.writes.updateRouteEgress(id, 'demo-vpn-2', ctx)
      await watch.fingerprint()
      const audit = createAuditService(database.db)
      expect(audit.list({ actor: 'external' }).items).toEqual([])
      expect(audit.list({ q: 'Lab NAS', category: 'route' }).items).toMatchObject([
        { action: 'routes.update', target: { label: 'Lab NAS' } }, { action: 'routes.update', target: { label: 'Lab NAS' } },
      ])
      const preWrites = () => snapshots.list({ limit: 20 }).items.filter(row => row.trigger === 'pre-write')
      expect(preWrites()).toHaveLength(1)
      expect(snapshots.item(preWrites()[0]!.id, 'trafficroutes', id).doc.network_id).toBe('demo-wan-1')
      at += 120_001
      await runtime.writes.updateRouteEgress(id, 'demo-vpn-3', ctx)
      await edit('trafficroutes', id, { network_id: 'demo-vpn-4' })
      const events: ControllerEvent[] = []
      service.engine.on('event', event => events.push(event))
      await watch.fingerprint()
      expect(preWrites()).toHaveLength(2)
      expect(audit.list({ actor: 'external', category: 'route', q: 'Lab NAS' }).items).toMatchObject([
        { target: { id }, action: 'config.changed', diff: [{ path: 'network_id', after: 'demo-vpn-4' }] },
      ])
      expect(events).toContainEqual({ type: 'config.external_change', resource: 'trafficroutes', itemId: id, label: 'Lab NAS' })
      await watch.fingerprint()
      expect(audit.list({ actor: 'external' }).items).toHaveLength(1)
    } finally {
      await starter.stop()
    }
  })

  it('imports system logs idempotently with source timestamps and omits arbitrary controller text', async () => {
    const entry = { _id: 'log-1', key: 'EVT_WU_Connected', timestamp: at - 5_000, message: 'password=raw-secret', token: 'raw-secret' }
    vi.spyOn(runtime.api, 'systemLog').mockResolvedValue({ data: [entry, entry], total_page_count: 1, total_element_count: 1, page_number: 0 })
    await createAuditWatch(database.db, service, () => at).logs()
    await createAuditWatch(database.db, service, () => at).logs()
    const { items } = createAuditService(database.db).list({ actor: 'unifi-log', q: 'EVT_WU_Connected' })
    expect(items).toMatchObject([{ ts: entry.timestamp, category: 'system', messageKey: 'audit.unifi.log',
      messageParams: { key: entry.key, message: entry.key } }])
    expect(JSON.stringify(items)).not.toContain('raw-secret')
  })

  it('renders Network 11 system-log templates from parameter names and re-imports rows stored by older builds', async () => {
    const scope = runtime.scope
    // A row imported by an older build that could not read the Network 11 format.
    database.db.insert(unifiLogEntries).values({ scope, fingerprint: 'old', ts: at - 60_000 }).run()
    createAuditService(database.db).record({ actor: { type: 'unifi-log', id: null, name: null }, category: 'system', action: 'unifi.log',
      severity: 'info', messageKey: 'audit.unifi.log', messageParams: { message: '[redacted]', key: 'unifi.event' } }, at - 60_000)
    const entry = {
      id: '0f8d7a52-6a43-4c1b-9b7e-4ad1c2f0e001', key: 'CLIENT_CONNECTED_WIRELESS', category: 'CLIENT_DEVICES', severity: 'LOW',
      timestamp: at - 30 * 60_000, title_raw: 'WiFi Client Connected', message: 'password=raw-secret',
      message_raw: '{CLIENT} connected to {NETWORK} with {PASSWORD}',
      parameters: { CLIENT: { id: '02:11:22:33:44:55', name: 'Demo Tablet', ip: '10.0.0.20' }, NETWORK: { id: 'net-1', name: 'Home' }, PASSWORD: { name: 'raw-secret' } },
    }
    const spy = vi.spyOn(runtime.api, 'systemLog').mockResolvedValue({ data: [entry], total_page_count: 1, total_element_count: 1, page_number: 0 })
    await createAuditWatch(database.db, service, () => at).logs()
    // The first run after the format change looks back a full day; later runs use the short window again.
    expect(spy.mock.calls[0]![1].timestampFrom).toBe(at - 86_400_000)
    const { items } = createAuditService(database.db).list({ actor: 'unifi-log' })
    expect(items).toMatchObject([{ ts: entry.timestamp, messageParams: {
      key: 'CLIENT_CONNECTED_WIRELESS', message: 'Demo Tablet connected to Home with [redacted]', title: 'WiFi Client Connected', category: 'CLIENT_DEVICES',
    }, target: { type: 'client', id: '02:11:22:33:44:55', label: 'Demo Tablet' } }])
    expect(JSON.stringify(items)).not.toContain('raw-secret')
    await createAuditWatch(database.db, service, () => at + 60_000).logs()
    expect(spy.mock.calls[1]![1].timestampFrom).toBe(at + 60_000 - 10 * 60_000)
    expect(createAuditService(database.db).list({ actor: 'unifi-log' }).items).toHaveLength(1)
  })

  it('rejects invalid cron expressions and treats unsupported deletes separately from creates', () => {
    const settings = createSettingsService(database.db)
    expect(() => settings.patch({ snapshots: { ...settings.get().snapshots, cron: 'bad cron' } }))
      .toThrow(expect.objectContaining({ data: { code: 'INVALID_SNAPSHOT_CRON' } }))
    for (const resource of ['objects', 'firewall-policies', 'wlanconf', 'users'] as const) {
      expect(restoreReason(resource, 'a', undefined, {}, undefined)).toBe('unsupported')
      expect(restoreReason(resource, 'a', { mac: 'ab:cd:ef:12:34:56' }, undefined, undefined)).toBeNull()
    }
  })
})
