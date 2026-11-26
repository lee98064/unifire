import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import capture from '../fixtures/wire/infra-capture-11.0.104.json'
import { createDatabase } from '../../server/db'
import { deviceRollupsHourly, deviceSamples, infraDevices } from '../../server/db/schema'
import { DAY, HOUR, MINUTE } from '../../server/engine/access-time'
import { availabilityByDevice, deviceEvents, deviceSeries } from '../../server/engine/infra/device-history'
import { createDeviceSampler } from '../../server/engine/infra/device-sampler'
import { createDeviceGraph, createPoeSafety } from '../../server/engine/infra/poe-safety'
import { buildPortViews } from '../../server/engine/infra/ports'
import { digest, fieldDiff, redactDocument, summary } from '../../server/engine/snapshots/diff'
import { createSyncCache } from '../../server/services/cache'
import { createSettingsService } from '../../server/services/settings'
import { deviceRadios, deviceState, deviceUplink, isGateway, normalizeDevice, normalizePort } from '../../server/unifi/device-shape'
import type { UnifiEndpoints } from '../../server/unifi/endpoints'
import { Device, Station } from '../../server/unifi/endpoints/schemas'
import { AP1, AP2, DESK_MAC, GATEWAY_MAC, MESH_MAC, SWITCH_MAC, buildMockDevices } from '../../server/unifi/mock/infra'
import { deviceConfig } from '../../server/unifi/snapshot-resources'
import { createWriteLedger } from '../../server/unifi/write-ledger'
import type { EngineEvents, InfraEvent } from '../../server/unifi/ws'

const site = 'default'
const scope = 'wp8:test'
const at = Date.UTC(2026, 10, 27, 4)
const captured = Device.array().parse(capture.resources['stat/device'].data)
const byMac = new Map(captured.map(device => [device.mac, device]))
const express = byMac.get(AP2)!
const gateway = byMac.get(GATEWAY_MAC)!
const core = byMac.get(SWITCH_MAC)!
const ap = byMac.get(AP1)!
const reading = (fields: Record<string, unknown> = {}) => Device.parse({
  mac: AP1, type: 'uap', model: 'U7PRO', name: 'AP fixture', adopted: true, version: '1.0', state: 1, ...fields,
})

describe('captured device shapes and PoE graph', () => {
  it('normalizes the Express 7 as an AP, while preserving the UDM switch ports', () => {
    expect([express, core, gateway].find(isGateway)).toEqual(gateway)
    expect(normalizeDevice(express)).toMatchObject({ type: 'ap', bands: ['2.4', '5', '6'], ports: { total: 2 } })
    expect(normalizeDevice(gateway)).toMatchObject({
      type: 'gateway', state: 'online', cpuPct: Number(gateway['system-stats']?.cpu),
      memPct: Number(gateway['system-stats']?.mem), tempC: Math.max(...gateway.temperatures!.map(temp => Number(temp.value))),
      ports: { total: 11, poe: 0 }, poe: null,
    })
    expect(normalizeDevice(core)).toMatchObject({ type: 'switch', tempC: 44, ports: { total: 18, poe: 16 },
      poe: { budgetW: 180 } })
    expect(normalizeDevice(core).poe?.usedW).toBeCloseTo(13.17)
    expect(deviceUplink(core)).toMatchObject({ mac: GATEWAY_MAC, type: 'wire', remotePort: 11, localPort: 18,
      speedMbps: 10000, fullDuplex: true })
    expect(deviceUplink({ ...ap, last_uplink: ap.uplink, uplink: null })).toEqual(deviceUplink(ap))
    expect(deviceUplink(buildMockDevices().find(device => device.mac === MESH_MAC)!))
      .toMatchObject({ mac: AP1, type: 'wireless', signal: -66 })
    const port13 = core.port_table!.find(port => port.port_idx === 13)!
    expect(normalizePort(core, port13)).toMatchObject({ maxSpeedMbps: 2500, media: 'rj45', poe: { powerW: 9.13 }, isUplink: false })
    expect(normalizePort(core, { port_idx: 17, media: 'SFP+', speeds: [100, '10000'] }))
      .toMatchObject({ maxSpeedMbps: 10000, media: 'sfp+' })
    expect(normalizePort(core, { port_idx: 17, media: 'SFP28' })?.media).toBe('sfp28')
    expect(normalizePort(core, { port_idx: 17, media: '10GBASE-T' })?.media).toBe('rj45')
  })

  it('merges configured and actual radios and maps device state codes', () => {
    expect(deviceRadios(ap)).toEqual(expect.arrayContaining([
      expect.objectContaining({ band: '2.4', radio: 'ng', widthMhz: 40, channel: 6 }),
      expect.objectContaining({ band: '5', radio: 'na', widthMhz: 160, channel: 44 }),
      expect.objectContaining({ band: '6', radio: '6e', widthMhz: 320, channel: 37 }),
    ]))
    const radio = reading({ radio_table: [{ name: 'w0', radio: 'ad', ht: '20' }],
      radio_table_stats: [{ name: 'w0', radio: 'ad', cu_total: 30, cu_self_rx: 12, cu_self_tx: 7, satisfaction: -1 }] })
    expect(deviceRadios(radio)[0]).toMatchObject({ band: '60', widthMhz: 20, interferencePct: 11, satisfaction: null })
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 99, null].map(state => deviceState(reading({ state })))).toEqual([
      'offline', 'online', 'adopting', 'unknown', 'upgrading', 'provisioning', 'offline', 'adopting', 'unknown', 'unknown', 'unknown',
    ])
    expect(deviceState(reading({ restarting: true }))).toBe('restarting')
  })

  it('handles all PoE reasons, including an unmanaged-switch host and a mesh branch', () => {
    const graph = createDeviceGraph(captured)
    const host = '02:ff:00:00:00:01'
    const deviceAt = (mac: string) => graph.byMac.get(mac)!
    const portAt = (mac: string, idx: number) => deviceAt(mac).port_table!.find(port => port.port_idx === idx)!
    const stations = [
      Station.parse({ mac: host, ip: '192.0.2.10', sw_mac: DESK_MAC, sw_port: 3, is_wired: true, hostname: 'Host' }),
      Station.parse({ mac: '02:ff:00:00:00:02', sw_mac: DESK_MAC, sw_port: 3, is_wired: true }),
      Station.parse({ mac: '02:ff:00:00:00:03', last_uplink_mac: DESK_MAC, last_uplink_remote_port: 3 }),
    ]
    const safety = createPoeSafety(graph, stations, { mac: null, ip: '192.0.2.10' })
    const check = (mac: string, idx: number) => safety(deviceAt(mac), portAt(mac, idx))
    expect(check(SWITCH_MAC, 13)).toEqual({ allowed: true, reasons: ['powers_ap'], requiresAck: true })
    expect(check(SWITCH_MAC, 15)).toMatchObject({ allowed: false, reasons: ['downstream_devices', 'unifire_host', 'gateway_path'] })
    expect(check(SWITCH_MAC, 18)).toMatchObject({ allowed: false, reasons: ['not_poe', 'uplink', 'gateway_path'] })
    expect(check(GATEWAY_MAC, 11).reasons).toEqual(expect.arrayContaining(['gateway_path', 'unifire_host']))
    expect(check(DESK_MAC, 3)).toMatchObject({ allowed: false, reasons: ['not_poe', 'unifire_host', 'gateway_path'] })
    expect(check(SWITCH_MAC, 3)).toEqual({ allowed: true, reasons: [], requiresAck: false })
    const mock = createDeviceGraph(buildMockDevices())
    expect(createPoeSafety(mock, [], { mac: null, ip: null })(core, portAt(SWITCH_MAC, 13)))
      .toEqual({ allowed: false, reasons: ['downstream_devices', 'powers_ap'], requiresAck: true })
    const ports = buildPortViews(deviceAt(DESK_MAC), graph, stations, safety, new Map([[host, 'household']]))
    expect(ports.find(port => port.idx === 3)?.peer).toMatchObject({ kind: 'unknown', mac: '02:00:00:00:00:28', personId: null })
    expect(ports.find(port => port.idx === 3)!.peer!.count).toBeGreaterThanOrEqual(3)
    expect(ports.find(port => port.idx === 4)?.peer).toMatchObject({ kind: 'device', mac: AP2 })
  })

  it('keeps only configuration in snapshots and redacts a rest/device-shaped document', () => {
    const before = deviceConfig(ap)
    const after = deviceConfig({
      ...ap, uptime: 100, tx_bytes: 42, locating: true, port_table: [],
      radio_table: ap.radio_table!.map(radio => ({ ...radio, tx_packets: 250, cu_total: 90, num_sta: 12 })).reverse(),
      radio_table_stats: [],
    })
    expect(digest(before)).toBe(digest(after))
    expect(fieldDiff(before, after)).toEqual([])
    const restDevice = {
      _id: 'console-switch-id', mac: SWITCH_MAC, model: 'USPM16P', name: 'Core Switch',
      port_overrides: [{ port_idx: 13, name: 'AP port', poe_mode: 'auto', x_port_secret: 'port-secret' }],
      x_adopt_password: 'adoption-secret', x_fingerprint: 'fingerprint-secret', x_ssh_keys: ['ssh-secret'],
      config_network: { type: 'static', ip: '192.0.2.3', x_password: 'network-secret' },
    }
    const redacted = redactDocument(restDevice)
    expect(JSON.stringify(redacted)).not.toContain('-secret')
    expect(redacted).toMatchObject({ x_adopt_password: null, x_fingerprint: null, x_ssh_keys: null,
      config_network: { x_password: null }, port_overrides: [{ port_idx: 13, x_port_secret: null }] })
    const left = deviceConfig(restDevice)
    const right = deviceConfig({ ...restDevice, port_overrides: [{ ...restDevice.port_overrides[0], poe_mode: 'off' }] })
    expect(summary('devices', 'Core Switch', 'modified', fieldDiff(left, right), left, right))
      .toEqual({ summaryKey: 'diff.device.port_override', summaryParams: { device: 'Core Switch', port: '13', field: 'poe_mode', from: 'auto', to: 'off' } })
  })
})

describe('infrastructure sampling', () => {
  let store: ReturnType<typeof createDatabase>
  let events: InfraEvent[]
  let sample: ReturnType<typeof createDeviceSampler>['sample']

  beforeEach(() => {
    store = createDatabase()
    events = []
    sample = createDeviceSampler(store.db, { emit: event => events.push(event), changed: () => {} }).sample
  })

  afterEach(() => store.sqlite.close())

  it('samples identical polls and ignores failed polls, with WS device reads spaced ten seconds apart', async () => {
    vi.useFakeTimers({ now: at })
    const engine: EngineEvents = new EventEmitter()
    const devices = vi.fn<UnifiEndpoints['devices']>().mockResolvedValue([express, gateway, ap])
    const api = { devices, gateway: async () => [express, gateway] } as UnifiEndpoints
    const cache = createSyncCache(api, { db: store.db, site, scope, engine, active: () => true, onPoll: () => {} })
    engine.on('event', event => {
      const poll = cache.devicePoll()
      if (event.type === 'cache.changed' && event.resource === 'devices' && poll) sample(cache.snapshot().devices, site, scope, poll.at)
    })
    cache.start()
    try {
      await cache.refresh('devices')
      expect(cache.gateway()?.mac).toBe(GATEWAY_MAC)
      devices.mockResolvedValue([express, gateway])
      for (let index = 0; index < 5; index++) engine.emit('event', { type: 'device.updated', mac: AP2, data: {} })
      await vi.advanceTimersByTimeAsync(9900)
      expect(devices).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(devices).toHaveBeenCalledTimes(2)
      expect(events).not.toContainEqual({ type: 'infra.offline', mac: AP1 })
      devices.mockRejectedValueOnce(new Error('failed poll'))
      await expect(cache.refresh('devices')).rejects.toThrow('failed poll')
      expect(events).not.toContainEqual({ type: 'infra.offline', mac: AP1 })
      await cache.refresh('devices')
      expect(events).toContainEqual({ type: 'infra.offline', mac: AP1 })
      expect(store.db.select().from(infraDevices).where(eq(infraDevices.mac, AP1)).get()?.lastState).toBe('offline')
    } finally {
      cache.stop()
      vi.useRealTimers()
    }
  })

  it('classifies unexpected, ledger-backed, upgrade, and offline-return reboots, and records firmware changes', () => {
    let time = at
    const ledger = createWriteLedger(() => time)
    const record = (fields: Record<string, unknown>) => sample([reading(fields)], site, scope, time, ledger.explainsDeviceReboot)
    record({ uptime: 50_000, upgradable: true, upgrade_to_firmware: '1.1' })
    time += 30_000
    record({ uptime: 20 })
    time += MINUTE
    record({ uptime: 1000 })
    ledger.recordDevicePower([AP1])
    time += 20_000
    record({ uptime: 10 })
    time += 16 * MINUTE
    record({ uptime: 1150 })
    time += 30_000
    record({ uptime: 1180, state: 4 })
    time += 30_000
    record({ uptime: 3, version: '2.0', upgradable: true, upgrade_to_firmware: '3.0' })
    time += MINUTE
    record({ uptime: 63, version: '2.0', upgradable: true, upgrade_to_firmware: '3.0' })
    time += MINUTE
    record({ uptime: 123, version: '2.0', upgradable: true, upgrade_to_firmware: '3.1', state: 0 })
    time += 120_000
    record({ uptime: 115, version: '2.0', upgradable: true, upgrade_to_firmware: '3.1' })
    const history = deviceEvents(store.db, AP1)
    expect(history.transitions.filter(item => ['unexpected_reboot', 'unifire_restart', 'upgrade'].includes(item.reason ?? ''))
      .map(item => item.reason)).toEqual(['unexpected_reboot', 'upgrade', 'unifire_restart', 'unexpected_reboot'])
    expect(history.firmware).toMatchObject([{ from: '1.0', to: '2.0' }])
    expect(events.filter(event => event.type === 'infra.firmware')).toEqual([
      { type: 'infra.firmware', mac: AP1, version: '3.0' }, { type: 'infra.firmware', mac: AP1, version: '3.1' },
    ])
    expect(events).toContainEqual({ type: 'infra.online', mac: AP1, downSec: 120 })
    expect(ledger.explainsDeviceReboot(AP1, time)).toBe(false)
  })

  it('detects a boot during an outage even without a prior uptime reading', () => {
    sample([reading({ state: 0 })], site, scope, at)
    sample([reading({ uptime: 12 })], site, scope, at + MINUTE)
    expect(events).toContainEqual({ type: 'infra.rebooted', mac: AP1, unexpected: true })
    expect(deviceEvents(store.db, AP1).transitions[0]).toMatchObject({ reason: 'unexpected_reboot', downSec: 60 })
  })

  it('deduplicates the minute, preserves sample gaps, and re-arms the temperature threshold after a 3 C drop', () => {
    for (let i = 0; i < 60; i++) {
      const t = at + 2 * MINUTE * i
      const temp = [80, 78, 81, 77, 81][i] ?? 65
      sample([reading({ state: i < 45 ? 1 : 0, general_temperature: temp })], site, scope, t)
      if (i === 0) sample([reading({ state: 1, general_temperature: 80, 'system-stats': { cpu: '42' } })], site, scope, t + 1000)
      if (i === 58) expect(availabilityByDevice(store.db, scope, t).get(AP1)).toBeNull()
    }
    expect(store.db.select().from(deviceSamples).all()).toHaveLength(60)
    expect(availabilityByDevice(store.db, scope, at + 118 * MINUTE).get(AP1)).toBe(0.75)
    expect(events.filter(event => event.type === 'infra.overheat')).toHaveLength(2)
    expect(deviceSeries(store.db, AP1, '24h', at + 118 * MINUTE).points[0]).toMatchObject({ ts: at, online: 1, cpuPct: 42 })
  })

  it('archives completed hours, exposes the live partial hour, and prunes both retentions', () => {
    const settings = createSettingsService(store.db)
    settings.patch({ infra: { ...settings.get().infra, retainRawDays: 1, retainRollupDays: 30 } })
    sample([reading({ 'system-stats': { cpu: '10' } })], site, scope, at)
    sample([reading({ 'system-stats': { cpu: '30' } })], site, scope, at + MINUTE)
    sample([reading({ state: 0 })], site, scope, at + 2 * MINUTE)
    sample([reading({ 'system-stats': { cpu: '60' } })], site, scope, at + HOUR)
    expect(store.db.select().from(deviceRollupsHourly).all()).toMatchObject([{ hourTs: at, onlineFraction: 2 / 3, cpuAvg: 20, cpuMax: 30 }])
    expect(deviceSeries(store.db, AP1, '7d', at + HOUR).points).toMatchObject([
      { ts: at, online: 2 / 3, cpuPct: 20 }, { ts: at + HOUR, online: 1, cpuPct: 60 },
    ])
    expect(deviceSeries(store.db, AP1, '30d', at + HOUR).points).toMatchObject([{ online: (2 / 3 + 1) / 2, cpuPct: 40 }])
    sample([reading()], site, scope, at + 2 * DAY)
    expect(store.db.select().from(deviceSamples).all().map(row => row.ts)).toEqual([at + 2 * DAY])
    expect(deviceSeries(store.db, AP1, '90d', at + 2 * DAY).bucketSec).toBe(21600)
    sample([reading()], site, scope, at + 32 * DAY)
    expect(store.db.select().from(deviceRollupsHourly).all().map(row => row.hourTs)).toEqual([at + 2 * DAY])
    expect(deviceEvents(store.db, AP1).transitions).not.toEqual([])
  })
})
