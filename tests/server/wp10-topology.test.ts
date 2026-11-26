import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import capture from '../fixtures/wire/infra-capture-11.0.104.json'
import type { EgressT } from '../../shared/schemas/egress'
import type { InfraDeviceT, PortViewT } from '../../shared/schemas/infra'
import { createDatabase } from '../../server/db'
import { createInfra } from '../../server/engine/infra'
import { createDeviceGraph, createPoeSafety } from '../../server/engine/infra/poe-safety'
import { buildPortViews } from '../../server/engine/infra/ports'
import { buildTopology } from '../../server/engine/infra/topology'
import { unknownHealth } from '../../server/engine/probes/health'
import type { ControllerService } from '../../server/services/controller'
import { normalizeDevice, normalizePort } from '../../server/unifi/device-shape'
import { Device, Station } from '../../server/unifi/endpoints/schemas'
import { AP1, AP2, DESK_MAC, GATEWAY_MAC, MESH_MAC, SWITCH_MAC } from '../../server/unifi/mock/infra'
import type { EngineEvents } from '../../server/unifi/ws'
import { createLiveBus } from '../../server/utils/bus'

const at = Date.UTC(2026, 9, 1)
const phone = '02:03:04:05:06:01'
const laptop = '02:03:04:05:06:02'
const nodeId = (mac: string) => 'dev:' + mac
const raw = Device.array().parse(capture.resources['stat/device'].data)
const normalize = (device: typeof raw[number]): InfraDeviceT => ({
  ...normalizeDevice(device), firstSeen: at, lastSeen: at, roomId: null, availability24h: null,
  lastReboot: null, locating: false, issues: [],
})
const egress = (id: string, kind: EgressT['kind'], status: EgressT['health']['status']): EgressT => ({
  id, name: id, kind, health: { ...unknownHealth, status }, wanGroup: kind === 'wan' ? 'WAN' : null, enabled: true,
  probe: { enabled: false, ip: null, routeId: null, state: 'disabled' }, color: '#ffffff', publicIp: null, routeCount: 0,
})
const fixtures = () => ({
  devices: raw.map(normalize),
  ports: raw.flatMap(device => (device.port_table ?? []).flatMap(rawPort => {
    const port = normalizePort(device, rawPort)
    return port ? [{ ...port, issues: [] as PortViewT['issues'] }] : []
  })),
  activeClients: [
    Station.parse({ mac: phone, ap_mac: AP1, signal: -54, 'rx_bytes-r': 25, 'tx_bytes-r': 10 }),
    Station.parse({ mac: laptop, sw_mac: SWITCH_MAC, sw_port: 9, is_wired: true }),
    Station.parse({ mac: AP1, sw_mac: SWITCH_MAC, sw_port: 13, is_wired: true }),
  ],
  identity: new Map([[phone, { name: 'Phone alias', personId: 'person' }]]),
  egresses: [egress('wan', 'wan', 'healthy'), egress('vpn', 'wireguard', 'down'), egress('wan2', 'wan', 'degraded')],
  gatewayTelemetry: raw.find(device => device.mac === GATEWAY_MAC),
  at,
})

describe('WP10 topology', () => {
  afterEach(() => vi.useRealTimers())

  it('builds the captured tree, adds egress health and groups direct clients without duplicating adopted devices', () => {
    const topology = buildTopology(fixtures())
    const link = (mac: string) => topology.edges.find(edge => edge.target === nodeId(mac))
    const group = (id: string) => topology.nodes.find(node => node.id === id)
    expect(topology.nodes.filter(node => node.parentId === null)).toEqual([
      expect.objectContaining({ id: nodeId(GATEWAY_MAC), kind: 'gateway' }),
    ])
    expect(link(SWITCH_MAC)).toMatchObject({ source: nodeId(GATEWAY_MAC), speedMbps: 10_000, parentPort: 11, childPort: 18 })
    expect(link(DESK_MAC)).toMatchObject({ source: nodeId(SWITCH_MAC), speedMbps: 2500, parentPort: 15 })
    expect(link(AP1)).toMatchObject({ source: nodeId(SWITCH_MAC), speedMbps: 2500, parentPort: 13, poeW: 9.13 })
    expect(link(AP2)).toMatchObject({ source: nodeId(DESK_MAC), speedMbps: 2500, parentPort: 4 })
    expect(group('egress:wan')).toMatchObject({ state: 'ok', parentId: nodeId(GATEWAY_MAC) })
    expect(group('egress:wan2')).toMatchObject({ state: 'warning' })
    expect(group('egress:vpn')).toMatchObject({ state: 'down' })
    expect(topology.edges.find(edge => edge.target === 'egress:wan')).toMatchObject({
      medium: 'wan', speedMbps: 1000, upBps: 1608 * 8, parentPort: 9,
    })
    expect(topology.edges.find(edge => edge.target === 'egress:vpn')).toMatchObject({ medium: 'vpn', downBps: null, upBps: null })
    expect(group('clients:' + AP1)).toMatchObject({ clients: 1, people: ['person'], members: [
      { mac: phone, name: 'Phone alias', personId: 'person', signal: -54, rxBps: 200, txBps: 80 },
    ] })
    expect(group(nodeId(AP1))?.people).toEqual(['person'])
    expect(group('clients:' + SWITCH_MAC + ':9')?.members[0]?.mac).toBe(laptop)
    expect(group('clients:' + SWITCH_MAC + ':13')).toBeUndefined()
    expect(topology.edges.find(edge => edge.target === 'clients:' + AP1)).toMatchObject({ medium: 'wireless', downBps: 200, upBps: 80 })
  })

  it('flags each bottleneck kind and anchors unknown or cyclic uplinks at the gateway', () => {
    const input = fixtures()
    const core = input.devices.find(device => device.mac === SWITCH_MAC)!
    const ap = input.devices.find(device => device.mac === AP1)!
    const desk = input.devices.find(device => device.mac === DESK_MAC)!
    const express = input.devices.find(device => device.mac === AP2)!
    Object.assign(core.uplink!, { speedMbps: 1000, fullDuplex: false })
    const upstream = input.ports.find(port => port.switchMac === GATEWAY_MAC && port.idx === 11)!
    Object.assign(upstream, { txBps: 800_000_000, rxBps: 145_000_000, issues: ['errors'] })
    input.devices.push({ ...ap, mac: MESH_MAC, uplink: { ...ap.uplink!, mac: AP1, type: 'wireless', signal: -71 } })
    desk.uplink!.mac = '02:00:00:00:00:99'
    express.uplink!.mac = AP2
    const topology = buildTopology(input)
    const link = (mac: string) => topology.edges.find(edge => edge.target === nodeId(mac))
    expect(link(SWITCH_MAC)).toMatchObject({
      downBps: 800_000_000, upBps: 145_000_000, utilizationPct: 80, maxSpeedMbps: 10000,
      bottlenecks: ['speed_below_capability', 'high_utilization', 'half_duplex', 'errors'],
    })
    expect(link(MESH_MAC)).toMatchObject({ signal: -71, bottlenecks: ['weak_mesh'], medium: 'wireless' })
    for (const mac of [DESK_MAC, AP2]) {
      expect(link(mac)).toMatchObject({ source: nodeId(GATEWAY_MAC), speedMbps: null, bottlenecks: [] })
    }
    expect(topology.bottlenecks).toHaveLength(5)
    expect(topology.bottlenecks[0]).toMatchObject({ messageKey: 'topology.bottleneck.speed_below_capability',
      messageParams: { speed: '1000', max: '10000', util: '80.0' } })
    expect(topology.nodes.find(node => node.mac === SWITCH_MAC)?.state).toBe('warning')
  })

  it('throttles topology invalidations across client and device updates and cancels on stop', async () => {
    vi.useFakeTimers({ now: at })
    const store = createDatabase()
    const engine: EngineEvents = new EventEmitter()
    const service = { engine } as ControllerService
    const bus = createLiveBus()
    const timestamps: number[] = []
    bus.subscribe(event => { if (event.type === 'topology') timestamps.push(event.data.ts) })
    const stop = createInfra(store.db, service, { bus }).start(() => true)
    try {
      engine.emit('event', { type: 'cache.changed', resource: 'activeClients' })
      engine.emit('event', { type: 'cache.changed', resource: 'devices' })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(timestamps).toEqual([at])
      await vi.advanceTimersByTimeAsync(1)
      expect(timestamps).toEqual([at, at + 10_000])
      engine.emit('event', { type: 'cache.changed', resource: 'activeClients' })
    } finally {
      await stop()
      store.sqlite.close()
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(timestamps).toHaveLength(2)
  })

  it('uses last_connection and then longest known port attachment on a multi-MAC port', () => {
    const core = structuredClone(raw.find(device => device.mac === SWITCH_MAC)!)
    const port = core.port_table!.find(row => row.port_idx === 9)!
    Object.assign(port, { up: true, mac_table_count: 2, last_connection: { mac: laptop, connected: false } })
    const clients = [phone, laptop].map(mac => Station.parse({ mac, is_wired: true, sw_mac: core.mac, sw_port: 9 }))
    const graph = createDeviceGraph([core])
    const safety = createPoeSafety(graph, clients, { mac: null, ip: null })
    const peer = (rows: typeof clients) => buildPortViews(core, graph, rows, safety, new Map(),
      new Map([['9/' + phone, at], ['9/' + laptop, at + 1]])).find(port => port.idx === 9)?.peer
    expect(peer(clients)?.mac).toBe(laptop)
    expect(peer(clients.toReversed())?.mac).toBe(laptop)
    port.last_connection = null
    expect(peer(clients.toReversed())?.mac).toBe(phone)
  })
})
