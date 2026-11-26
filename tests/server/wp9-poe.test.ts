import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoeScheduleInput } from '../../shared/schemas/infra'
import { RuleInput } from '../../shared/schemas/automation'
import { createDatabase } from '../../server/db'
import { auditEvents, poeApplied, poeOffLog, poeOverrides } from '../../server/db/schema'
import { HOUR, MINUTE } from '../../server/engine/access-time'
import { createInfra } from '../../server/engine/infra'
import { createPoe, offHoursPerWeek, poeWindows } from '../../server/engine/infra/poe'
import { createManagedRoutes } from '../../server/engine/managed-routes'
import { createNotifier } from '../../server/engine/notifiers'
import { createRules } from '../../server/engine/rules'
import { createSnapshots } from '../../server/engine/snapshots'
import { createWatchdogs } from '../../server/engine/watchdogs'
import { createWol } from '../../server/engine/wol'
import { createAccess } from '../../server/services/access'
import { createControllerService, systemContext, type ControllerService } from '../../server/services/controller'
import { AP2, SWITCH_MAC } from '../../server/unifi/mock/infra'
import { UnifiError } from '../../server/unifi/errors'
import { createWriteGate, mergePortOverride } from '../../server/unifi/writes'
import { Device } from '../../server/unifi/endpoints/schemas'
import type { UnifiEndpoints } from '../../server/unifi/endpoints'
import { osPaths } from '../../server/unifi/paths'
import { initializeCrypto } from '../../server/utils/crypto'

const at = Date.UTC(2026, 10, 23, 10, 0)
const base = { name: 'Quiet hours', switchMac: SWITCH_MAC, portIdx: 8, timezone: 'UTC', acknowledgedAp: true,
  offWindows: [{ days: [0], start: '10:00', end: '10:01', enabled: true }], mode: 'active' }
const schedule = (patch: Record<string, unknown> = {}) => PoeScheduleInput.parse({ ...base, ...patch })
const switchPort = (portIdx: number) => ({ switchMac: SWITCH_MAC, portIdx })
const qualify = (portIdx: number, acknowledgedAp = false) => ({ ...switchPort(portIdx), acknowledgedAp, confirm: true as const })
const off = (portIdx: number, minutes: number | null = null) => ({ ...switchPort(portIdx), action: 'set' as const, on: false, minutes, acknowledgedAp: true })

describe('WP9 PoE reconciler on the fake UniFi controller', () => {
  let store: ReturnType<typeof createDatabase>
  let service: ControllerService
  let poe: ReturnType<typeof createPoe>
  let clock: number
  let wallAnchor: number | undefined
  const stops: (() => Promise<unknown>)[] = []
  const now = () => Math.floor(clock + (wallAnchor === undefined ? 0 : performance.now() - wallAnchor))
  beforeEach(async () => {
    clock = at + 100
    wallAnchor = undefined
    vi.spyOn(Date, 'now').mockImplementation(now)
    initializeCrypto(Buffer.alloc(32, 9))
    store = createDatabase()
    service = await createControllerService(store.db, { mock: true })
    await service.ready()
    await service.setMode('live', systemContext)
    poe = createPoe(store.db, service, now)
  })
  afterEach(async () => {
    await Promise.allSettled(stops.splice(0).reverse().map(stop => stop()))
    await service?.stop()
    store.sqlite.close()
    vi.restoreAllMocks()
  })

  const runtime = () => service.runtime!
  const core = () => runtime().api.device(SWITCH_MAC)
  const mode = async (idx: number) => (await core()).port_table!.find(row => row.port_idx === idx)?.poe_mode

  it('enforces a live schedule at its boundary, restores a new entry, and sees the AP return after boot', async () => {
    await poe.qualify(qualify(3), systemContext)
    clock = at - 250
    const infra = createInfra(store.db, service, { now })
    const control = infra.poe
    stops.push(infra.start(() => true))
    const start = await control.create(schedule(), systemContext)
    expect(start.state).toMatchObject({ status: 'ok', actual: 'on', nextChangeAt: at, nextDesired: 'off' })
    wallAnchor = performance.now()
    await expect.poll(() => mode(8), { timeout: 3500 }).toBe('off')
    await expect.poll(async () => (await runtime().api.device(AP2)).state).toBe(0)
    await expect.poll(() => store.db.select().from(poeApplied).get()?.phase).toBe('held')
    const watchdogs = createWatchdogs(store.db, service, async () => {}, { now })
    expect(watchdogs.poeHold(SWITCH_MAC, 8)).toBe(true)
    await expect(watchdogs.cyclePort(SWITCH_MAC, 8, systemContext)).rejects.toMatchObject({ code: 'POE_HELD' })
    expect((await core()).port_overrides?.some(row => row.port_idx === 8)).toBe(true)

    clock = at + MINUTE
    wallAnchor = undefined
    service.engine.emit('event', { type: 'cache.changed', resource: 'devices' })
    await expect.poll(() => mode(8), { timeout: 3500 }).toBe('auto')
    expect((await core()).port_overrides?.some(row => row.port_idx === 8)).toBe(false)
    expect((await runtime().api.device(AP2)).state).toBe(0)
    clock += MINUTE + 1
    await runtime().cache.refreshAfterCurrent('devices')
    const ap = await runtime().api.device(AP2)
    expect(ap.state).toBe(1)
    expect(ap.uptime).toBeLessThan(10)
    expect(runtime().ledger.explainsDeviceReboot(AP2)).toBe(true)
    expect(store.db.select().from(poeOffLog).get()).toMatchObject({ end: at + MINUTE, scheduleId: start.id })
    expect(watchdogs.poeHold(SWITCH_MAC, 8)).toBe(true)
    clock += 10 * MINUTE
    expect(watchdogs.poeHold(SWITCH_MAC, 8)).toBe(false)
  })

  it('uses override priority, relinquishes temporary holds, and never turns on externally-off ports', async () => {
    await poe.qualify(qualify(3), systemContext)
    await expect(poe.override({ ...off(9), on: true }, systemContext)).rejects.toMatchObject({ code: 'POE_NOT_OWNED' })
    await poe.override(off(9), systemContext)
    expect(store.db.select().from(poeApplied).all()).toEqual([])
    await poe.override(off(4, 1), systemContext)
    expect(await mode(4)).toBe('off')
    clock += MINUTE
    await poe.reconcile()
    expect(await mode(4)).toBe('auto')
    clock = at + 100
    const active = await poe.create(schedule(), systemContext)
    expect(active.state).toMatchObject({ actual: 'off', desired: 'off' })
    await poe.override({ ...off(8), on: true }, systemContext)
    expect(await mode(8)).toBe('auto')
    await poe.override({ ...switchPort(8), action: 'clear' }, systemContext)
    expect(await mode(8)).toBe('off')
    await service.setMode('dry-run', systemContext)
    await expect(poe.delete(active.id, systemContext)).rejects.toMatchObject({ code: 'DRY_RUN' })
    expect(await mode(8)).toBe('off')
    await service.setMode('live', systemContext)
    await poe.delete(active.id, systemContext)
    expect(await mode(8)).toBe('auto')
    expect(await mode(9)).toBe('off')
  })

  it('honors preview, dry-run, AP acknowledgement, topology safety and Network version qualification', async () => {
    const unqualified = await poe.create(schedule(), systemContext)
    expect(unqualified.state.status).toBe('unqualified')
    expect(await mode(8)).toBe('auto')
    await expect(poe.override(off(8), systemContext)).rejects.toMatchObject({ code: 'POE_NOT_QUALIFIED' })
    await expect(poe.qualify(qualify(13, true), systemContext)).rejects.toMatchObject({ code: 'POE_UNSAFE' })
    await expect(poe.qualify(qualify(8), systemContext)).rejects.toMatchObject({ code: 'POE_ACK_REQUIRED' })
    await service.setMode('dry-run', systemContext)
    await expect(poe.qualify(qualify(3), systemContext)).rejects.toMatchObject({ code: 'DRY_RUN' })
    await poe.reconcile()
    expect(poe.overview().schedules[0]?.state.status).toBe('dry_run')
    expect(store.db.select().from(auditEvents).all()).toContainEqual(expect.objectContaining({ action: 'poe.portOverride', dryRun: true }))
    await service.setMode('live', systemContext)
    await poe.qualify(qualify(3), systemContext)
    const blocked = await poe.update(unqualified.id, { acknowledgedAp: false }, systemContext)
    expect(blocked.state).toMatchObject({ status: 'blocked', reasonKey: 'poe.reason.ack_required' })
    expect((await poe.update(unqualified.id, { mode: 'preview' }, systemContext)).state.status).toBe('preview')
    expect(await mode(8)).toBe('auto')
    runtime().status.networkVersion = '99.0.0'
    expect(poe.overview().qualification.qualified).toBe(false)
  })

  it('pauses drift until resumed and restores the previous mode of an existing override', async () => {
    await poe.qualify(qualify(3), systemContext)
    const active = await poe.create(schedule(), systemContext)
    const held = store.db.select().from(poeApplied).get()!
    // Simulate an administrator re-enabling the port during the off window.
    const read = runtime().api.device
    vi.spyOn(runtime().api, 'device').mockImplementationOnce(async mac => {
      const device = await read(mac)
      device.port_table!.find(row => row.port_idx === 8)!.poe_mode = 'auto'
      return device
    })
    await poe.reconcile()
    expect(store.db.select().from(poeApplied).all()).toEqual([])
    expect(poe.overview().schedules[0]?.state.status).toBe('drift')
    expect((await poe.update(active.id, { name: 'Edited' }, systemContext)).state.status).toBe('drift')
    await poe.resume(active.id, systemContext)
    expect(poe.overview().schedules[0]?.state.status).not.toBe('drift')
    expect(held.createdEntry).toBe(true)

    const previous = (await core()).port_overrides!
    const candidate = previous.find(row => row.port_idx === 11)!
    expect(candidate).toBeDefined()
    await poe.override(off(11), systemContext)
    expect(store.db.select().from(poeApplied).all()).toContainEqual(expect.objectContaining({ portIdx: 11, createdEntry: false, previousMode: 'auto' }))
    await poe.override({ ...switchPort(11), action: 'clear' }, systemContext)
    expect((await core()).port_overrides!.find(row => row.port_idx === 11)).toEqual(candidate)
  })

  it('rolls back qualification after a failed read-back and records the failure', async () => {
    const hooks = vi.fn()
    service.beforeWrite.add(hooks)
    const read = runtime().api.device
    let injected = false
    vi.spyOn(runtime().api, 'device').mockImplementation(async mac => {
      const device = await read(mac)
      if (!injected && device.port_table?.some(port => port.port_idx === 3 && port.poe_mode === 'off')) {
        injected = true
        throw new UnifiError('UNIFI_INVALID_RESPONSE')
      }
      return device
    })
    await expect(poe.qualify(qualify(3), systemContext)).rejects.toMatchObject({ code: 'UNIFI_INVALID_RESPONSE' })
    expect(hooks).toHaveBeenCalledOnce()
    expect(await mode(3)).toBe('auto')
    expect(store.db.select().from(poeApplied).all()).toEqual([])
    expect(poe.overview().qualification).toMatchObject({ qualified: false, error: 'UNIFI_INVALID_RESPONSE' })
  })

  it('restores only port overrides from device snapshots through the write gate', async () => {
    await poe.qualify(qualify(3), systemContext)
    const snapshots = createSnapshots(store.db, service)
    const original = await snapshots.create(undefined, systemContext)
    await poe.override(off(3), systemContext)
    const doc = await core()
    const diff = await snapshots.diff(original.id)
    expect(diff.changes.find(change => change.resource === 'devices' && change.itemId === doc._id)?.restorable).toBe(true)
    const plan = await snapshots.apply(original.id, { dryRun: false, items: [{ resource: 'devices', itemId: doc._id! }] }, systemContext)
    expect(plan.steps[0]).toMatchObject({ result: 'applied', body: { port_overrides: expect.any(Array) } })
    expect(Object.keys(plan.steps[0]!.body!)).toEqual(['port_overrides'])
    expect(await mode(3)).toBe('auto')
  })

  it('runs a PoE rule action and re-arms the budget trigger five percentage points below threshold', async () => {
    await poe.qualify(qualify(3), systemContext)
    const infra = createInfra(store.db, service, { now })
    const access = createAccess(store.db, service)
    const notifications = createNotifier(store.db, access, { mock: true })
    const rules = createRules(store.db, service, { access, infra, notifications, managed: createManagedRoutes(store.db, service),
      watchdogs: createWatchdogs(store.db, service, notifications.notify), wol: createWol(store.db, service) }, { now })
    const rule = rules.create(RuleInput.parse({ name: 'Budget cap', description: null, conditions: [], enabled: true, trigger: { type: 'poe.budget', switchMac: SWITCH_MAC, percent: 90 },
      actions: [{ type: 'poe.set', ...switchPort(4), on: false, minutes: 3 }], cooldownSeconds: 0 }))
    const issue = rules.create(RuleInput.parse({ name: 'Port error', description: null, conditions: [], enabled: true, trigger: { type: 'port.issue', switchMac: SWITCH_MAC, kinds: ['errors'] },
      actions: [{ type: 'notify', title: 'Port event' }], cooldownSeconds: 0 }))
    const dispatch = (percent: number) => rules.dispatch({ type: 'poe.budget', switchMac: SWITCH_MAC, percent })
    await dispatch(89)
    await dispatch(90)
    await dispatch(86)
    await dispatch(95)
    expect(rules.page({ limit: 10, ruleId: rule.id }).items).toHaveLength(1)
    expect(store.db.select().from(poeOverrides).get()).toMatchObject({ source: 'rule', ruleId: rule.id, endsAt: clock + 3 * MINUTE })
    expect(await mode(4)).toBe('off')
    await dispatch(85)
    clock += 200
    await dispatch(91)
    expect(rules.page({ limit: 10, ruleId: rule.id }).items).toHaveLength(2)
    const portEvent = { type: 'port.issue', switchMac: SWITCH_MAC, portIdx: 4, eventId: 'event' }
    await rules.dispatch({ ...portEvent, kind: 'recovered' })
    await rules.dispatch({ ...portEvent, kind: 'flapping' })
    await rules.dispatch({ ...portEvent, kind: 'errors' })
    expect(rules.page({ limit: 10, ruleId: issue.id }).items).toHaveLength(1)
  })
})

describe('WP9 PoE write and window utilities', () => {
  it('preserves all captured override fields, uses a fresh read after the snapshot, and retries read-back', async () => {
    const store = createDatabase()
    try {
      const { buildMockDevices } = await import('../../server/unifi/mock/infra')
      const devices = buildMockDevices()
      const core = devices.find(device => device.mac === SWITCH_MAC)!
      const target = 11
      const readBefore = structuredClone(core.port_overrides!)
      let writes = 0
      let readsSinceWrite = 0
      const write = vi.fn(async (_method: string, _path: string, payload: unknown) => {
        writes++
        const port = core.port_table!.find(row => row.port_idx === target)!
        const data = payload as { port_overrides: typeof readBefore }
        core.port_overrides = data.port_overrides
        port.poe_mode = 'off'
      })
      const device = vi.fn(async () => {
        const copy = Device.parse(structuredClone(core))
        if (writes && !readsSinceWrite++) copy.port_table!.find(row => row.port_idx === target)!.poe_mode = 'auto'
        return copy
      })
      const api = { devices: async () => devices, device, activeClients: async () => [] } as unknown as UnifiEndpoints
      const hook = vi.fn(() => { core.port_overrides![0]!.extra_from_controller = 'new' })
      const verifyDelay = vi.fn(async () => {})
      const paths = osPaths('default')
      const gate = createWriteGate({ origin: new URL('http://test.local'), paths, write }, api, {
        site: 'default', mode: () => 'live', ownership: () => ({ managed: new Map(), excluded: new Set(), probes: new Set() }),
        baseline: () => undefined, active: () => true, preWrite: () => true, hooks: new Set([hook]), audit: { record: vi.fn() }, verifyDelay,
      })
      expect(await gate.updatePortOverride(SWITCH_MAC, target, { poe_mode: 'off' }, systemContext)).toMatchObject({ verified: true })
      readBefore[0]!.extra_from_controller = 'new'
      expect(write).toHaveBeenCalledWith('PUT', paths.classic(`rest/device/${core._id}`),
        { port_overrides: readBefore.map(entry => entry.port_idx === target ? { ...entry, poe_mode: 'off' } : entry) })
      expect(verifyDelay).toHaveBeenCalledOnce()
      expect(mergePortOverride([{ port_idx: 1, name: 'Preserved' }, { port_idx: 2, poe_mode: 'off' }], 2, { remove: true }))
        .toEqual([{ port_idx: 1, name: 'Preserved' }])
    } finally {
      store.sqlite.close()
    }
  })

  it('combines crossing-midnight windows and handles DST gaps and overlaps', () => {
    const overnight = schedule({ offWindows: [{ days: [0], start: '23:00', end: '02:00', enabled: true },
      { days: [1], start: '01:00', end: '03:00', enabled: true }] })
    expect(offHoursPerWeek(overnight.offWindows)).toBe(4)
    expect(poeWindows(overnight, Date.UTC(2026, 10, 24, 1))[0])
      .toEqual({ start: Date.UTC(2026, 10, 23, 23), end: Date.UTC(2026, 10, 24, 3) })
    const spring = schedule({ timezone: 'America/New_York', offWindows: [{ days: [6], start: '02:15', end: '04:00', enabled: true }] })
    expect(poeWindows(spring, Date.UTC(2026, 2, 8, 5))[0])
      .toEqual({ start: Date.UTC(2026, 2, 8, 7, 15), end: Date.UTC(2026, 2, 8, 8) })
    const fall = schedule({ timezone: 'America/New_York', offWindows: [{ days: [6], start: '01:15', end: '01:45', enabled: true }] })
    const window = poeWindows(fall, Date.UTC(2026, 10, 1, 4))[0]!
    expect(window.end - window.start).toBe(HOUR + 30 * MINUTE)
  })
})
