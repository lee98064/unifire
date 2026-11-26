import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonInput } from '../../shared/schemas/access'
import { RuleInput } from '../../shared/schemas/automation'
import { RoomInput } from '../../shared/schemas/infra'
import { createDatabase } from '../../server/db'
import { auditEvents, clientRfMinutes, infraDevices, stickyFlags, stickyNudges } from '../../server/db/schema'
import { DAY, HOUR, MINUTE } from '../../server/engine/access-time'
import { setManualBlock } from '../../server/engine/blocks'
import { createInfra } from '../../server/engine/infra'
import { createRoamTracker, clientRoamHistory } from '../../server/engine/infra/roaming'
import { createManagedRoutes } from '../../server/engine/managed-routes'
import { createNotifier } from '../../server/engine/notifiers'
import { updatePresence } from '../../server/engine/presence'
import { createRules } from '../../server/engine/rules'
import { createWatchdogs } from '../../server/engine/watchdogs'
import { createWol } from '../../server/engine/wol'
import { createAccess } from '../../server/services/access'
import { createControllerService, systemContext, type ControllerService } from '../../server/services/controller'
import { createSettingsService } from '../../server/services/settings'
import { Station } from '../../server/unifi/endpoints/schemas'
import { AP1, AP2, MESH_MAC, SWITCH_MAC } from '../../server/unifi/mock/infra'
import type { ControllerEvent } from '../../server/unifi/ws'
import { initializeCrypto } from '../../server/utils/crypto'

const phone = '00:1c:b3:10:00:02'
const tablet = '00:16:32:10:00:03'
const station = (mac: string, ap_mac: string, signal: number, radio = 'na', channel = 44) =>
  Station.parse({ mac, ap_mac, signal, radio, channel, is_wired: false })

describe('WP10 room presence and client roaming', () => {
  let store: ReturnType<typeof createDatabase>
  let service: ControllerService
  let time: number
  const stops: Array<() => Promise<void>> = []

  beforeEach(async () => {
    time = Math.floor(Date.now() / MINUTE) * MINUTE
    store = createDatabase()
    initializeCrypto(Buffer.alloc(32, 10))
    service = await createControllerService(store.db, { mock: true })
    await service.ready()
  })

  afterEach(async () => {
    await Promise.allSettled(stops.splice(0).reverse().map(stop => stop()))
    await service.stop()
    store.sqlite.close()
    vi.restoreAllMocks()
  })

  function startInfra() {
    const infra = createInfra(store.db, service, { now: () => time })
    stops.push(infra.start(() => true))
    return infra
  }

  it('uses the strongest presence device, suppresses A→B→A, closes on leave and deletes occupied rooms', () => {
    const { db } = store
    const scope = service.runtime!.scope
    const infra = startInfra()
    const access = createAccess(db, service, () => time)
    const rooms = access.rooms
    const a = rooms.create(RoomInput.parse({ name: 'Living Room', order: 2 }))
    const b = rooms.create(RoomInput.parse({ name: 'Study', order: 1 }))
    expect(() => rooms.assign(SWITCH_MAC, a.id)).toThrow()
    rooms.assign(AP1, a.id)
    rooms.assign(AP2, b.id)
    expect(infra.get(AP1).roomId).toBe(a.id)
    const person = access.people.create(PersonInput.parse({
      name: 'Alder', color: '#ffffff', presenceMacs: [phone, tablet], deviceMacs: [phone, tablet],
    }))
    const events: ControllerEvent[] = []
    service.engine.on('event', event => {
      if (event.type === 'person.room_entered' || event.type === 'person.room_left') events.push(event)
    })
    const update = (phoneSignal: number, tabletSignal: number, online = true) => {
      const rows = online ? [station(phone, AP1, phoneSignal), station(tablet, AP2, tabletSignal)] : []
      const roster = access.people.rows(time)
      updatePresence(db, service.engine, roster, new Set(rows.map(row => row.mac)), time, 1,
        home => rooms.observe(scope, roster, home, rows, time, 2))
    }
    const current = () => rooms.timeline(time - HOUR, time).people[0]?.current?.roomId
    update(-41, -62)
    update(-41, -62)
    expect(current()).toBeUndefined()
    time += MINUTE
    update(-41, -62)
    expect(current()).toBe(a.id)
    time += MINUTE
    update(-75, -50)
    time += MINUTE
    update(-41, -62)
    expect(events.map(event => event.type)).toEqual(['person.room_entered'])
    time += MINUTE
    update(-75, -50)
    time += MINUTE
    update(-75, -50)
    expect(current()).toBe(b.id)
    expect(rooms.list()[0]).toMatchObject({ id: b.id, occupants: [person.id] })
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: 'person.room_left', roomId: a.id, personId: person.id }),
      expect.objectContaining({ type: 'person.room_entered', roomId: b.id, personId: person.id }),
    ])
    time += MINUTE
    update(0, 0, false)
    expect(current()).toBe(b.id)
    time += MINUTE
    update(0, 0, false)
    expect(current()).toBeUndefined()
    expect(rooms.timeline(time - HOUR, time).people[0]?.segments.at(-1)).toMatchObject({ end: time, roomId: b.id })

    time += MINUTE
    update(-75, -50)
    time += MINUTE
    update(-75, -50)
    rooms.delete(b.id)
    expect(current()).toBeUndefined()
    expect(rooms.list().map(room => room.id)).toEqual([a.id])
    expect(infra.get(AP2).roomId).toBeNull()
    expect(db.select().from(infraDevices).where(eq(infraDevices.mac, AP2)).get()?.roomId).toBeNull()
    expect(rooms.timeline(time - HOUR, time).people[0]?.segments.at(-1)).toMatchObject({ end: time, roomId: b.id })
    expect(events.at(-1)).toMatchObject({ type: 'person.room_left', roomId: b.id, room: 'Study' })
  })

  it('deduplicates WS and poll, preserves RF metadata and limits historical signal points', () => {
    const { db } = store
    const scope = service.runtime!.scope
    const recover = vi.fn()
    const tracker = createRoamTracker(db, recover)
    const a = station(phone, AP1, -71, 'ng', 6)
    const b = station(phone, AP2, -50, '6e', 37)
    tracker.poll(scope, [a], time)
    tracker.poll(scope, [b], time + 1000)
    tracker.observe(scope, { ...b, signal: -49 }, 'ws', time + 2000)
    tracker.poll(scope, [a], time + 3000, time + 500) // In flight around the WS frame.
    tracker.observe(scope, a, 'ws', time + 4000)
    tracker.observe(scope, b, 'ws', time + 5000)
    tracker.poll(scope, [b], time + 6000)
    const history = clientRoamHistory(db, scope, phone, time, time + MINUTE)
    expect(history.events).toEqual([
      expect.objectContaining({ ts: time + 1000, fromApMac: AP1, toApMac: AP2, fromSignal: -71, toSignal: -49, band: '6', channel: 37, source: 'ws' }),
      expect.objectContaining({ ts: time + 4000, fromApMac: AP2, toApMac: AP1, fromSignal: -49, band: '2.4', source: 'ws' }),
    ])
    const c = station(phone, MESH_MAC, -60)
    tracker.poll(scope, [c], time + 70_000)
    expect(clientRoamHistory(db, scope, phone, time + MINUTE, time + HOUR).events).toEqual([
      expect.objectContaining({ fromApMac: AP2, toApMac: MESH_MAC, fromSignal: -50, band: '5', source: 'poll' }),
    ])
    expect(recover).toHaveBeenCalledTimes(4)
    expect(clientRoamHistory(db, 'different-controller', phone, time, time + HOUR).events).toEqual([])
    const rows = Array.from({ length: 1600 }, (_, index) => ({ scope, mac: phone, ts: time + index * MINUTE,
      apMac: index < 1200 ? AP1 : AP2, signal: index < 1200 ? -71 : -50 }))
    for (let i = 0; i < rows.length; i += 100) db.insert(clientRfMinutes).values(rows.slice(i, i + 100)).run()
    const series = clientRoamHistory(db, scope, phone, time, time + 1600 * MINUTE)
    expect(series.signal.length).toBeLessThanOrEqual(1440)
    expect(series.apDwell).toEqual([expect.objectContaining({ apMac: AP1, minutes: 1200 }), expect.objectContaining({ apMac: AP2, minutes: 400 })])
    tracker.sample(scope, [], time + 92 * DAY)
    expect(clientRoamHistory(db, scope, phone, time, time + 1600 * MINUTE)).toMatchObject({ events: [], signal: [] })
  })

  it('connects the mock STA-frame and poll paths to persisted roam history', async () => {
    const access = createAccess(store.db, service)
    stops.push(access.start(() => true))
    const runtime = service.runtime!
    await runtime.cache.refreshAfterCurrent('activeClients')
    const from = Date.now() - 1000
    service.mockScenario!('roam', 'poll')
    await runtime.cache.refreshAfterCurrent('activeClients')
    expect(access.roams(phone, from, Date.now()).events).toEqual([
      expect.objectContaining({ source: 'poll', fromApMac: AP1, toApMac: AP2 }),
    ])
    service.mockScenario!('roam')
    await runtime.cache.refreshAfterCurrent('activeClients')
    await expect.poll(() => access.roams(phone, from, Date.now()).events).toEqual([
      expect.objectContaining({ source: 'poll', fromApMac: AP1, toApMac: AP2 }),
      expect.objectContaining({ source: 'ws', fromApMac: AP2, toApMac: AP1 }),
    ])
  })

  it('dispatches filtered room rules with current-room conditions and renders webhook placeholders', async () => {
    const { db } = store
    startInfra()
    const access = createAccess(db, service, () => time)
    const room = access.rooms.create(RoomInput.parse({ name: 'Living "Room"' }))
    access.rooms.assign(AP1, room.id)
    const person = access.people.create(PersonInput.parse({ name: 'Alder', color: '#ffffff',
      presenceMacs: [phone], deviceMacs: [phone] }))
    const notifications = createNotifier(db, access, { mock: true })
    const request = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
    const rules = createRules(db, service, { access, notifications, managed: createManagedRoutes(db, service),
      watchdogs: createWatchdogs(db, service, notifications.notify), wol: createWol(db, service) }, { now: () => time, http: request })
    const rule = rules.create(RuleInput.parse({
      name: 'Room rule', description: null, trigger: { type: 'person.room_entered', personId: person.id, roomId: room.id },
      enabled: true, cooldownSeconds: 0, conditions: [{ type: 'person.room', personId: person.id, roomId: room.id, inRoom: true }],
      actions: [{ type: 'webhook', url: 'https://example.test/rooms', method: 'POST', body: '{"room":"{{room}}","person":"{{person}}"}' }],
    }))
    const kickRule = rules.create(RuleInput.parse({
      name: 'Kick after entering', description: null, trigger: { type: 'person.room_entered', roomId: 'other' },
      enabled: true, cooldownSeconds: 0, conditions: [], actions: [{ type: 'client.kick', mac: phone }],
    }))
    stops.push(rules.start(() => true))
    access.rooms.observe(service.runtime!.scope, [person], new Set([person.id]), [station(phone, AP1, -45)], time, 1)
    await expect.poll(() => request.mock.calls.length).toBe(1)
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ person: 'Alder', room: 'Living "Room"' })
    expect(rules.page({ ruleId: kickRule.id, limit: 10 }).items).toEqual([])
    expect((await rules.test(kickRule.id, true)).results[0]).toMatchObject({ action: 'client.kick', ok: true, message: 'rule.result.would' })
    expect((await rules.dispatch({ type: 'person.room_entered', personId: person.id, roomId: 'other' }))[0]?.results[0])
      .toMatchObject({ action: 'client.kick', ok: true, message: null })
    expect(rules.page({ limit: 10, ruleId: rule.id }).items[0]?.event).toMatchObject({ room: 'Living "Room"', person: 'Alder' })
    access.rooms.delete(room.id)
    const result = await rules.dispatch({ type: 'person.room_entered', personId: person.id, roomId: room.id })
    expect(result[0]?.skipped).toBe('conditions')
  })

  it('detects weak clients, recovers on better signal or roam, and forgets recovered flags after one hour', async () => {
    const { db } = store
    const settings = createSettingsService(db)
    settings.patch({ sticky: { ...settings.get().sticky, enabled: true, minutes: 2 } })
    const access = createAccess(db, service, () => time)
    const runtime = service.runtime!
    const sample = async () => {
      await runtime.cache.refreshAfterCurrent('activeClients')
      await access.sticky.sample(runtime, time, () => true)
      time += MINUTE
    }
    service.mockScenario!('sticky')
    await sample()
    expect(access.sticky.list().find(row => row.mac === phone)).toBeUndefined()
    await sample()
    expect(access.sticky.list().find(row => row.mac === phone)).toMatchObject({ status: 'sticky', apMac: MESH_MAC, signal: -80, otherAps: 2 })
    const snapshot = runtime.cache.snapshot()
    vi.spyOn(runtime.cache, 'snapshot').mockReturnValue({ ...snapshot, activeClients: snapshot.activeClients.map(client =>
      client.mac === phone ? { ...client, signal: -69 } : client) })
    await sample()
    expect(access.sticky.list().find(row => row.mac === phone)).toMatchObject({ status: 'recovered', signal: -69 })
    vi.restoreAllMocks()
    await sample()
    await sample()
    expect(access.sticky.list().find(row => row.mac === phone)?.status).toBe('sticky')
    access.sticky.recover(runtime.scope, phone, time)
    expect(access.sticky.list().find(row => row.mac === phone)?.status).toBe('recovered')
    time += HOUR
    service.mockScenario!('recover')
    await sample()
    expect(access.sticky.list().find(row => row.mac === phone)).toBeUndefined()
    expect(db.select().from(stickyFlags).where(eq(stickyFlags.mac, phone)).get()).toBeUndefined()
  })

  it('guards nudge commands with the live rate, cooldown, daily cap, blocked state and global dry-run', async () => {
    const { db } = store
    const settings = createSettingsService(db)
    const patch = (values: Partial<ReturnType<typeof settings.get>['sticky']>) =>
      settings.patch({ sticky: { ...settings.get().sticky, ...values } })
    patch({ enabled: true, nudge: true, minutes: 1, maxNudgesPerDay: 2, skipAboveBps: 10 })
    const access = createAccess(db, service, () => time)
    const runtime = service.runtime!
    const sample = async () => {
      service.mockScenario!('sticky')
      await runtime.cache.refreshAfterCurrent('activeClients')
      await access.sticky.sample(runtime, time, () => true)
      time += MINUTE
    }
    const nudges = () => db.select().from(stickyNudges).where(eq(stickyNudges.mac, phone)).all().length
    await sample() // Busy.
    expect(nudges()).toBe(0)
    patch({ skipAboveBps: 2_000_000 })
    await service.setMode('dry-run', systemContext)
    await sample()
    expect(nudges()).toBe(0)
    expect(access.sticky.list().find(row => row.mac === phone)?.status).toBe('sticky')
    expect(db.select().from(auditEvents).where(eq(auditEvents.action, 'client.kick')).all())
      .toContainEqual(expect.objectContaining({ dryRun: true, actorType: 'system', category: 'client' }))

    await service.setMode('live', systemContext)
    setManualBlock(db, phone, time + MINUTE)
    await sample() // Desired block is present before UniFi sees it.
    expect(nudges()).toBe(0)
    const active = await runtime.api.activeClients()
    const reads = vi.spyOn(runtime.api, 'activeClients').mockResolvedValue(active.map(client =>
      client.mac === phone ? { ...client, blocked: true } : client))
    await sample()
    expect(nudges()).toBe(0)
    reads.mockRestore()

    await sample()
    expect(nudges()).toBe(1)
    expect(access.sticky.list().find(row => row.mac === phone)).toMatchObject({ status: 'nudged', nudges24h: 1 })
    await sample()
    expect(nudges()).toBe(1)
    time += 30 * MINUTE
    await sample()
    expect(nudges()).toBe(2)
    time += 30 * MINUTE
    await sample()
    expect(nudges()).toBe(2)
    time += DAY
    await sample()
    expect(nudges()).toBe(1)
  })
})
