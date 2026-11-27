import { randomUUID } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEventT } from '../../shared/schemas/system'
import { createDatabase } from '../../server/db'
import { deviceSamples, energyHourly, incidentSignals, people, personDevices, poeApplied, snapshots } from '../../server/db/schema'
import { DAY, HOUR, MINUTE } from '../../server/engine/access-time'
import { archiveDeviceSamples } from '../../server/engine/infra/device-history'
import { createDeviceSampler } from '../../server/engine/infra/device-sampler'
import { infraDashboard, listInfraDevices } from '../../server/engine/infra/device-views'
import { observePortEnergy } from '../../server/engine/infra/energy'
import { incidentToJoin, resolutionAt, summarize, type Signal, type SignalFacts } from '../../server/engine/infra/incidents/correlate'
import { createIncidentEngine } from '../../server/engine/infra/incidents/signals'
import { createIncidentStore } from '../../server/engine/infra/incidents/store'
import { releasePoe } from '../../server/engine/infra/poe-state'
import { createPortHealth } from '../../server/engine/infra/port-health'
import { infrastructureReport } from '../../server/engine/reports/infra'
import { matchesTrigger } from '../../server/engine/rules'
import { createAuditService } from '../../server/services/audit'
import { createControllerService, type ControllerService } from '../../server/services/controller'
import { createSettingsService } from '../../server/services/settings'
import { AP1, AP2, GATEWAY_MAC, MESH_MAC, SWITCH_MAC } from '../../server/unifi/mock/infra'
import type { ControllerEvent } from '../../server/unifi/ws'
import { createLiveBus } from '../../server/utils/bus'
import { initializeCrypto } from '../../server/utils/crypto'

const start = Date.UTC(2026, 10, 30, 16)
const ancestors = [SWITCH_MAC, GATEWAY_MAC]
const signal = (kind: Signal['kind'], ts: number, facts: SignalFacts = {}): Signal => ({
  id: randomUUID(), kind, ts, facts, suspect: false, severity: 'warning', messageKey: 'incident.signal.' + kind,
  messageParams: {}, ref: facts.mac ? { type: 'device', id: facts.mac, label: facts.mac } : null,
})
const down = (mac: string, ts: number, parents: string[] = ancestors) =>
  signal('device_offline', ts, { failure: 'device/' + mac, mac, ancestors: parents })
const up = (mac: string, ts: number) => signal('device_online', ts, { recovers: ['device/' + mac], mac })
const candidate = (signals: Signal[]) => ({ latestAt: signals.at(-1)!.ts, signals })

describe('WP11 correlation and storage', () => {
  it('joins a reboot, downstream outage and client burst, preferring the most upstream fault', () => {
    const core = signal('device_rebooted', start, {
      failure: 'reboot/core', mac: SWITCH_MAC, ancestors: [GATEWAY_MAC],
      devices: [
        { mac: SWITCH_MAC, clients: 2, people: [], groups: ['clients:' + SWITCH_MAC + ':9'] },
        { mac: AP1, clients: 5, people: ['alice'], groups: ['clients:' + AP1] },
      ],
    })
    const ap = down(AP1, start + MINUTE)
    const clients = signal('mass_disconnect', start + 2 * MINUTE, {
      failure: 'mass/ap', mac: AP1, ancestors,
      devices: [{ mac: AP1, clients: 6, people: ['alice', 'bob'], groups: ['clients:' + AP1] }],
    })
    const open = candidate([core])
    expect(incidentToJoin(ap, [open], 10)).toBe(open)
    expect(incidentToJoin(clients, [candidate([core, ap])], 10)).toBeDefined()
    const summary = summarize([ap, core, clients], 20, 'warning')
    expect(summary).toMatchObject({
      root: { kind: 'device_rebooted', ref: { id: SWITCH_MAC } }, severity: 'warning',
      titleParams: { devices: '2', clients: '8', people: '2' },
      impact: { devices: [SWITCH_MAC, AP1], clients: 8, people: ['alice', 'bob'], egresses: [] },
      affectedNodes: ['dev:' + SWITCH_MAC, 'dev:' + AP1, 'clients:' + SWITCH_MAC + ':9', 'clients:' + AP1],
    })
    expect(summarize([ap, core, clients], 16, 'warning').severity).toBe('critical')
    expect(summarize([ap, core, clients], 20, 'critical').severity).toBe('critical')
  })

  it('keeps sibling or expired failures separate and correlates globally scoped failures', () => {
    const ap = candidate([down(AP1, start)])
    expect(incidentToJoin(down(AP2, start + MINUTE), [ap], 10)).toBeUndefined()
    expect(incidentToJoin(down(AP1, start + 11 * MINUTE), [ap], 10)).toBeUndefined()
    const wan = signal('wan_down', start, { global: true, failure: 'wan/a', egressId: 'a' })
    const egress = signal('egress_down', start + MINUTE, { global: true, failure: 'egress/b', egressId: 'b' })
    expect(incidentToJoin(egress, [candidate([wan])], 10)).toBeDefined()
    const gateway = down(GATEWAY_MAC, start + 2 * MINUTE, [])
    gateway.facts.global = true
    expect(summarize([wan, egress, gateway], 0, 'warning')).toMatchObject({
      root: { kind: 'wan_down' }, impact: { egresses: ['a', 'b'] }, affectedNodes: ['egress:a', 'egress:b'],
    })
  })

  it('attaches related port issues, opens on flapping, and brackets suspects with scoped snapshots', () => {
    const { db, sqlite } = createDatabase()
    try {
      const store = createIncidentStore(db, 'site')
      const downgrade = signal('port_issue', start - MINUTE, { mac: AP1, ancestors })
      expect(store.persist(downgrade, 0, 10)).toEqual([])
      for (const measurement of [start - 16 * MINUTE, start - 15 * MINUTE, start - 3 * MINUTE]) {
        store.persist(signal('config_change', measurement), 0, 10)
      }
      const flap = signal('port_issue', start, { mac: AP1, ancestors, failure: 'flap/ap' })
      const id = store.persist(flap, 0, 10)[0]!.incident.id
      expect(store.persist(signal('port_issue', start + 1, { mac: MESH_MAC, ancestors: [AP1, ...ancestors] }), 0, 10)[0])
        .toMatchObject({ event: 'changed', incident: { id } })
      store.persist(signal('config_change', start + 2), 0, 10)
      const detail = () => store.detail(id)
      expect(detail().signals.filter(row => row.suspect).map(row => row.ts))
        .toEqual([start - 15 * MINUTE, start - 3 * MINUTE])
      expect(detail()).toMatchObject({ root: { kind: 'port_issue' }, suspectCount: 2, signalCount: 4, diff: null })
      const saveSnapshot = (id: string, ts: number, controllerScope = 'site') => db.insert(snapshots)
        .values({ id, ts, controllerScope, trigger: 'manual', complete: true, failed: [], counts: {}, sizeBytes: 0 }).run()
      saveSnapshot('older', start - 20 * MINUTE)
      saveSnapshot('pre-change', start - 16 * MINUTE)
      expect(detail().diff).toEqual({ fromSnapshotId: 'pre-change', toSnapshotId: null })
      saveSnapshot('other-site', start - 14 * MINUTE, 'other-site')
      saveSnapshot('post-change', start - 13 * MINUTE)
      saveSnapshot('recent', start - MINUTE)
      expect(detail().diff).toEqual({ fromSnapshotId: 'pre-change', toSnapshotId: 'post-change' })
      expect(createIncidentStore(db, 'other-site').list({ limit: 20 }).items).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('runs a fresh quiet period after a repeated failure and retains only one year of incident history', () => {
    const first = down(AP1, start)
    const recovered = up(AP1, start + MINUTE)
    const repeated = down(AP1, start + 4 * MINUTE)
    const recoveredAgain = up(AP1, start + 6 * MINUTE)
    expect(resolutionAt([first, recovered], 5, start + 6 * MINUTE - 1)).toBeNull()
    expect(resolutionAt([first, recovered], 5, start + 6 * MINUTE)).toBe(recovered.ts)
    expect(resolutionAt([first, recovered, repeated], 5, start + 15 * MINUTE)).toBeNull()
    expect(resolutionAt([first, recovered, repeated, recoveredAgain], 5, start + 11 * MINUTE)).toBe(recoveredAgain.ts)

    const { db, sqlite } = createDatabase()
    try {
      const store = createIncidentStore(db, 'site')
      const old = store.persist(first, 0, 10)[0]!.incident
      const other = store.persist(down(AP2, start - MINUTE), 0, 10)[0]!.incident
      store.persist(recovered, 0, 10)
      store.settle(5, start + 6 * MINUTE)
      expect(store.list({ status: 'resolved', limit: 1 }).items).toMatchObject([{ id: old.id, resolvedAt: recovered.ts }])
      const page = store.list({ limit: 1 })
      expect(page.items[0]?.id).toBe(other.id)
      expect(store.list({ cursor: page.nextCursor!, limit: 1 }).items[0]?.id).toBe(old.id)
      expect(() => store.list({ cursor: '!', limit: 1 })).toThrow()
      expect(store.update(old.id, { note: 'Checked the AP', acknowledged: true })).toMatchObject({ acknowledged: true })
      expect(store.update(old.id, { note: null })).toMatchObject({ acknowledged: true, note: null })
      store.prune(start + 365 * DAY + 1)
      expect(store.list({ limit: 1 }).items).toEqual([])
      expect(db.select().from(incidentSignals).all()).toEqual([])
    } finally {
      sqlite.close()
    }
  })
})

describe('WP11 mock incident engine and report', () => {
  let database: ReturnType<typeof createDatabase>
  let service: ControllerService
  let stop: () => void
  let at: number
  let events: ControllerEvent[]
  let live: LiveEventT[]
  let bus: ReturnType<typeof createLiveBus>
  let sampler: ReturnType<typeof createDeviceSampler>

  const emit = (event: ControllerEvent) => service.engine.emit('event', event)
  const run = () => service.runtime!
  const store = () => createIncidentStore(database.db, run().scope)
  const view = (mac: string) => listInfraDevices(database.db, service, at, mac)[0]!
  const poll = async () => {
    await run().cache.refreshAfterCurrent('devices')
    sampler.sample(run().cache.snapshot().devices, run().config.site, run().scope, at, run().ledger.explainsDeviceReboot)
  }
  const notices = () => events.filter(event => event.type === 'notification'
    && (event.event === 'incident_opened' || event.event === 'incident_resolved'))

  beforeEach(async () => {
    at = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => at)
    events = []
    live = []
    bus = createLiveBus()
    bus.subscribe(event => live.push(event))
    initializeCrypto(Buffer.alloc(32, 11))
    database = createDatabase()
    service = await createControllerService(database.db, { mock: true })
    await service.ready()
    service.engine.on('event', event => events.push(event))
    stop = createIncidentEngine(database.db, service, () => at, bus).start(() => true)
    sampler = createDeviceSampler(database.db, { emit, changed: () => {} })
    await poll()
  })

  afterEach(async () => {
    stop?.()
    await service?.stop()
    database.sqlite.close()
    vi.restoreAllMocks()
  })

  it('produces one switch incident with child and mass disconnect signals and measures presence impact', async () => {
    const clients = run().cache.snapshot().activeClients.filter(row => row.ap_mac === AP2)
    database.db.insert(people).values([
      { id: 'present', name: 'Present', avatar: '', color: '', createdAt: at },
      { id: 'owner', name: 'Owner', avatar: '', color: '', createdAt: at },
    ]).run()
    for (const identity of [
      { mac: clients[0]!.mac, personId: 'present', presence: true },
      { mac: clients[1]!.mac, personId: 'owner', presence: false },
    ]) {
      database.db.insert(personDevices).values(identity).onConflictDoUpdate({
        target: personDevices.mac, set: { personId: identity.personId, presence: identity.presence },
      }).run()
    }

    service.mockScenario!('offline-switch', 'poll')
    await poll()
    at += MINUTE
    await poll()
    await run().cache.refreshAfterCurrent('activeClients')
    const opened = store().list({ status: 'open', limit: 10 }).items
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ severity: 'critical', root: { kind: 'device_offline', ref: { id: SWITCH_MAC } } })
    const detail = () => store().detail(opened[0]!.id)
    expect(detail().signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'device_offline', ref: expect.objectContaining({ id: AP2 }) }),
      expect.objectContaining({ kind: 'mass_disconnect' }),
    ]))
    expect(detail().impact.people).toContain('present')
    expect(detail().impact.people).not.toContain('owner')
    expect(detail().affectedNodes).toContain('clients:' + AP2)
    expect(notices()).toEqual([expect.objectContaining({ event: 'incident_opened', severity: 'critical' })])
    expect(infraDashboard(database.db, service, at).openIncidents).toBe(1)

    service.mockScenario!('recover', 'poll')
    at += MINUTE
    await poll()
    await run().cache.refreshAfterCurrent('activeClients')
    expect(detail().signals.some(row => row.kind === 'clients_returned')).toBe(true)
    at += 5 * MINUTE
    emit({ type: 'routing.settings' })
    expect(detail()).toMatchObject({ status: 'resolved', resolvedAt: at - 5 * MINUTE })
    expect(notices().at(-1)).toMatchObject({ event: 'incident_resolved', duration: 60 })
  })

  it('ignores Unifire restarts, notifies on escalation once, and emits the rule trigger only when opened', () => {
    const warningRule = { type: 'incident.opened', minSeverity: 'warning' } as const
    const criticalRule = { type: 'incident.opened', minSeverity: 'critical' } as const
    emit({ type: 'infra.rebooted', mac: AP1, unexpected: false, at })
    expect(store().list({ limit: 10 }).items).toEqual([])
    emit({ type: 'infra.rebooted', mac: AP1, unexpected: true, at })
    const trigger = events.find(event => event.type === 'incident.opened')!
    expect(matchesTrigger(warningRule, trigger)).toBe(true)
    expect(matchesTrigger(criticalRule, trigger)).toBe(false)
    expect(trigger).toMatchObject({ titleParams: { name: 'AP Living Room' }, severity: 'warning' })
    at += MINUTE
    emit({ type: 'infra.offline', mac: GATEWAY_MAC, at })
    emit({ type: 'infra.offline', mac: SWITCH_MAC, at })
    expect(events.filter(event => event.type === 'incident.opened')).toHaveLength(1)
    expect(notices()).toEqual([
      expect.objectContaining({ event: 'incident_opened', severity: 'warning' }),
      expect.objectContaining({ event: 'incident_opened', severity: 'critical' }),
    ])
    expect(live.filter(event => event.type === 'incident').at(-1)?.data).toMatchObject({ status: 'open', severity: 'critical' })
    expect(createAuditService(database.db, bus).list({ category: 'system' }).items.map(event => event.action))
      .toEqual(expect.arrayContaining(['incident.opened', 'incident.escalated']))
  })

  it('retains a warning reboot across restart, ignores unchanged boot times, and resolves it after quiet', async () => {
    const before = new Map(run().cache.snapshot().devices.map(row => [row.mac, row.uptime]))
    service.mockScenario!('reboot-ap', 'poll')
    await poll()
    const reboot = store().list({ status: 'open', limit: 10 }).items[0]!
    expect(reboot).toMatchObject({ severity: 'warning', root: { kind: 'device_rebooted', ref: { id: AP1 } } })
    const rebootTime = run().cache.snapshot().devices.find(row => row.mac === AP1)!.uptime!
    stop()
    await service.stop()
    at += 2 * MINUTE
    service = await createControllerService(database.db, { mock: true })
    await service.ready()
    stop = createIncidentEngine(database.db, service, () => at, bus).start(() => true)
    await poll()
    for (const row of run().cache.snapshot().devices) {
      expect(row.uptime).toBe((row.mac === AP1 ? rebootTime : before.get(row.mac)!) + 120)
    }
    expect(store().list({ limit: 10 }).items.map(row => row.id)).toEqual([reboot.id])
    at += 3 * MINUTE
    emit({ type: 'routing.settings' })
    expect(store().detail(reboot.id)).toMatchObject({ status: 'resolved', resolvedAt: reboot.openedAt })
  })

  it('escalates only after the last WAN goes down and waits for both WAN and egress recovery', () => {
    const ids = ['demo-wan-1', 'demo-wan-2']
    const readWans = (values: (boolean | null)[]) => emit({
      type: 'wan.observed', at, readings: ids.map((id, index) => ({ id, name: id, up: values[index]! })),
    })
    const settings = createSettingsService(database.db)
    settings.patch({ incidents: { ...settings.get().incidents, notifyMinSeverity: 'critical' } })
    readWans([true, true])
    readWans([false, true])
    emit({ type: 'egress.down', egressId: ids[0]!, at })
    const opened = store().list({ limit: 10 }).items[0]!
    expect(opened).toMatchObject({ severity: 'warning', root: { kind: 'wan_down' } })
    expect(notices()).toEqual([])
    at += MINUTE
    readWans([false, null])
    expect(store().detail(opened.id).severity).toBe('warning')
    readWans([false, false])
    expect(store().detail(opened.id).severity).toBe('critical')
    at += MINUTE
    readWans([true, true])
    at += 5 * MINUTE
    emit({ type: 'routing.settings' })
    expect(store().detail(opened.id).status).toBe('open')
    emit({ type: 'egress.up', egressId: ids[0]!, at })
    at += 5 * MINUTE
    emit({ type: 'routing.settings' })
    expect(store().detail(opened.id)).toMatchObject({ status: 'resolved', severity: 'critical', resolvedAt: at - 5 * MINUTE })
    expect(notices().map(event => event.event)).toEqual(['incident_opened', 'incident_resolved'])
  })

  it('waits for the disconnect threshold and at least 70 percent of the lost clients to return', async () => {
    const lost = run().cache.snapshot().activeClients.filter(client => client.ap_mac === AP2).slice(0, 5)
    expect(lost).toHaveLength(5)
    for (const data of lost.slice(0, 4)) emit({ type: 'client.disconnected', mac: data.mac, data })
    await Promise.resolve()
    expect(store().list({ limit: 10 }).items).toEqual([])
    emit({ type: 'client.disconnected', mac: lost[4]!.mac, data: lost[4]! })
    await Promise.resolve()
    const opened = store().list({ limit: 10 }).items[0]!
    expect(opened.root).toMatchObject({ kind: 'mass_disconnect', ref: { id: AP2 } })
    for (const data of lost.slice(0, 3)) emit({ type: 'client.connected', mac: data.mac, data })
    await Promise.resolve()
    expect(store().detail(opened.id).signals.map(row => row.kind)).toEqual(['mass_disconnect'])
    emit({ type: 'client.connected', mac: lost[3]!.mac, data: lost[3]! })
    await Promise.resolve()
    expect(store().detail(opened.id).signals.at(-1)).toMatchObject({ kind: 'clients_returned', messageParams: { count: '4' } })
  })

  it('turns down/up transitions on an adopted-device port into an uplink incident and recovery', () => {
    const health = createPortHealth(database.db, service, bus)
    const { devices, activeClients } = run().cache.snapshot()
    const reading = (up: boolean) => health.sample(devices.map(row => row.mac === SWITCH_MAC
      ? { ...row, port_table: row.port_table?.map(port => port.port_idx === 13 ? { ...port, up } : port) }
      : row), activeClients, run().scope, at, observePortEnergy)
    reading(true)
    at += MINUTE
    reading(false)
    const opened = store().list({ limit: 10 }).items[0]!
    expect(opened.root).toMatchObject({ kind: 'uplink_down', ref: { id: SWITCH_MAC + ':13' } })
    expect(opened.impact.devices).toEqual(expect.arrayContaining([AP1, MESH_MAC]))
    at += MINUTE
    reading(true)
    expect(store().detail(opened.id).signals.map(row => row.kind)).toEqual(['uplink_down', 'uplink_up'])
    at += 5 * MINUTE
    emit({ type: 'routing.settings' })
    expect(store().detail(opened.id)).toMatchObject({ status: 'resolved', resolvedAt: at - 5 * MINUTE })
  })

  it('suppresses planned PoE-off and client losses through boot grace, then detects a continuing outage', async () => {
    const key = { scope: run().scope, switchMac: SWITCH_MAC, portIdx: 8 }
    database.db.insert(poeApplied).values({
      ...key, source: 'manual', phase: 'held', label: 'Study AP override', previousMode: 'auto', createdEntry: true, at,
    }).run()
    const attached = run().cache.snapshot().activeClients.filter(client => client.ap_mac === AP2)
    expect(attached.length).toBeGreaterThanOrEqual(5)
    const devices = run().cache.snapshot().devices.map(row => row.mac === AP2 ? { ...row, state: 0 } : row)
    at += MINUTE
    sampler.sample(devices, run().config.site, run().scope, at)
    for (const client of attached) emit({ type: 'client.disconnected', mac: client.mac, data: client })
    await Promise.resolve()
    expect(view(AP2).issues).toEqual([{
      kind: 'offline', severity: 'info', messageKey: 'infra.issue.poe_scheduled_off', messageParams: { schedule: 'Study AP override' },
    }])
    expect(infraDashboard(database.db, service, at)).toMatchObject({ online: 6, offline: 0 })
    const event = events.find(event => event.type === 'infra.offline' && event.mac === AP2)!
    expect(event).toMatchObject({ planned: true })
    expect(matchesTrigger({ type: 'infra.offline', minutes: 0, mac: AP2 }, event)).toBe(false)
    releasePoe(database.db, key, at, true)
    at += 9 * MINUTE
    sampler.sample(devices, run().config.site, run().scope, at)
    emit({ type: 'infra.rebooted', mac: AP2, unexpected: true, at })
    expect(view(AP2).issues[0]?.messageParams.schedule).toBe('Study AP override')
    expect(database.db.select().from(incidentSignals).all()).toEqual([])
    at += MINUTE
    sampler.sample(devices, run().config.site, run().scope, at)
    expect(store().list({ limit: 10 }).items).toMatchObject([{ root: { kind: 'device_offline', ref: { id: AP2 } } }])
  })

  it('reports Taipei month boundaries, sample gaps, rolled data, clipped duration, MTTR and energy', () => {
    const { db } = database
    db.delete(deviceSamples).where(eq(deviceSamples.mac, AP1)).run()
    db.insert(deviceSamples).values([
      { mac: AP1, ts: start - MINUTE, state: 'offline', temp: 99 },
      { mac: AP1, ts: start, state: 'online', cpu: 20, mem: 40, temp: 60 },
      { mac: AP1, ts: start + 2 * MINUTE, state: 'offline' },
      { mac: AP1, ts: start + 4 * MINUTE, state: 'offline', planned: true },
      { mac: AP2, ts: start + 4 * MINUTE, state: 'online' },
    ]).onConflictDoNothing().run()
    archiveDeviceSamples(db, start - HOUR, start + HOUR, { retainRawDays: 7, retainRollupDays: 400 })
    db.delete(deviceSamples).where(lt(deviceSamples.ts, start + 6 * MINUTE)).run()
    db.insert(deviceSamples).values({ mac: AP1, ts: start + 7 * MINUTE, state: 'online', cpu: 50, temp: 65 }).run()
    db.insert(energyHourly).values({ scope: run().scope, switchMac: SWITCH_MAC, portIdx: 8,
      hourTs: start, wh: 5, sampledMs: 10 * MINUTE }).run()

    const incidents = store()
    incidents.persist(down(AP1, start - MINUTE), 0, 10)
    incidents.persist(up(AP1, start + 2 * MINUTE), 0, 10)
    incidents.settle(0, start + 2 * MINUTE)
    incidents.persist(down(AP1, start + 3 * MINUTE), 0, 10)
    incidents.persist(up(AP1, start + 4 * MINUTE), 0, 10)
    incidents.settle(0, start + 4 * MINUTE)
    incidents.persist(down(AP1, start + 6 * MINUTE), 0, 10)

    createSettingsService(db).patch({ timezone: 'Asia/Taipei' })
    const report = infrastructureReport(db, service, '2026-12', start + 10 * MINUTE)
    expect(report).toMatchObject({
      from: start, to: Date.UTC(2026, 11, 31, 16), coverage: 0.4, energyWh: 5,
      incidents: { count: 3, critical: 0, totalSec: 420, mttrSec: 120, byRoot: [{ kind: 'device_offline', count: 3 }] },
    })
    expect(report.devices.find(device => device.mac === AP1)).toMatchObject({
      availability: 0.75, downtimeSec: 60, cpuAvg: 35, memAvg: 40, tempMax: 65,
    })
    expect(report.incidents.longest.map(row => row.openedAt)).toEqual([start + 6 * MINUTE, start - MINUTE, start + 3 * MINUTE])
    expect(infrastructureReport(db, service, '2027-01', start).coverage).toBe(0)
  })
})
