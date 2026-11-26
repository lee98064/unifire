import { z } from 'zod'
import capture from '../../../tests/fixtures/wire/infra-capture-11.0.104.json'
import { createDeviceGraph, wiredAttachment } from '../../engine/infra/poe-safety'
import { deviceState, finiteNumber, isGateway } from '../device-shape'
import { poeCapable, portIndex } from '../poe-ports'
import { Device, type WireDevice, type WireDoc, type WireStation } from '../endpoints/schemas'

export const GATEWAY_MAC = '02:00:00:00:00:01'
export const SWITCH_MAC = '02:00:00:00:00:03'
export const DESK_MAC = '02:00:00:00:00:13'
export const AP1 = '02:00:00:00:00:11'
export const AP2 = '02:00:00:00:00:1f'
export const MESH_MAC = '02:00:00:00:00:50'

const identities = [
  [GATEWAY_MAC, 'Dream Machine Pro', 'UniFi Dream Machine Pro'],
  [SWITCH_MAC, 'Core Switch', 'USW Pro Max 16 PoE'],
  [DESK_MAC, 'Desk Switch', 'USW Flex 2.5G 5'],
  [AP1, 'AP Living Room', 'U7 Pro'],
  [AP2, 'AP Study (Express 7)', 'UniFi Express 7'],
] as const
const capturedDevices = z.array(Device).parse(capture.resources['stat/device'].data)

export function buildMockDevices() {
  const devices = identities.map(([mac, name, model_name]) => ({
    ...structuredClone(capturedDevices.find(device => device.mac === mac)!), name, model_name,
  }))
  const byMac = new Map(devices.map(device => [device.mac, device]))
  for (const device of devices) {
    const names = new Map<number, string>()
    let sfp = 0
    for (const row of device.port_table ?? []) {
      const idx = portIndex(row.port_idx)
      if (idx === null) continue
      const friendly = device.mac === SWITCH_MAC ? ({ 8: 'Study AP', 9: 'Desk', 11: 'Garage camera', 13: 'Living room AP' } as Record<number, string>)[idx] : undefined
      const name = friendly ?? (String(row.media).includes('SFP') ? `SFP+ ${++sfp}` : `Port ${idx}`)
      names.set(idx, name)
      row.name = name
    }
    for (const row of device.port_overrides ?? []) {
      const name = names.get(portIndex(row.port_idx) ?? -1)
      if (name) row.name = name
    }
    const upstream = device.uplink?.uplink_mac && byMac.get(device.uplink.uplink_mac)
    if (device.uplink && upstream) device.uplink.uplink_device_name = upstream.name
  }

  const gateway = byMac.get(GATEWAY_MAC)!
  Object.assign(gateway, {
    wan1: { ...gateway.wan1, up: true, public_ip: '198.51.100.11', 'rx_bytes-r': 105_000, 'tx_bytes-r': 30_000 },
    wan2: { ...gateway.wan2, up: true, public_ip: '198.51.100.12', 'rx_bytes-r': 21_000, 'tx_bytes-r': 8_000 },
    wan3: { ...gateway.wan3, up: true, public_ip: '198.51.100.13', 'rx_bytes-r': 2_000, 'tx_bytes-r': 420 },
    'rx_bytes-r': 128_000, 'tx_bytes-r': 38_420,
  })
  // Keep the living-room AP's mesh branch and provide a separate leaf AP for PoE schedules.
  const core = byMac.get(SWITCH_MAC)!
  const desk = byMac.get(DESK_MAC)!
  const study = byMac.get(AP2)!
  Object.assign(study.uplink!, { uplink_mac: SWITCH_MAC, uplink_remote_port: 8, uplink_device_name: core.name, speed: 1000 })
  Object.assign(core.port_table!.find(row => row.port_idx === 8)!, {
    up: true, speed: 1000, poe_mode: 'auto', poe_power: '5.00', mac_table_count: 1,
    last_connection: { connected: true, mac: AP2 },
  })
  core.port_overrides = core.port_overrides?.filter(row => row.port_idx !== 8)
  core.downlink_table = [...core.downlink_table ?? [], { mac: AP2, port_idx: 8, speed: 1000, full_duplex: true }]
  desk.downlink_table = desk.downlink_table?.filter(row => row.mac !== AP2)
  Object.assign(desk.port_table!.find(row => row.port_idx === 4)!, { up: false, speed: 0, last_connection: null, mac_table_count: 0 })
  return [...devices, Device.parse({
    mac: MESH_MAC, _id: 'demo-infra-mesh', name: 'AP Garden', model_name: 'U6 Mesh', model: 'U6M',
    type: 'uap', adopted: true, state: 1, version: '6.7.31', ip: '192.0.2.80',
    uptime: 85_421, 'system-stats': { cpu: '12.0', mem: '42.0' }, general_temperature: 46, num_sta: 0,
    uplink: { type: 'wireless', uplink_mac: AP1, uplink_device_name: 'AP Living Room', signal: -66,
      'rx_bytes-r': 12_000, 'tx_bytes-r': 4200 },
    radio_table: [{ name: 'wifi0', radio: 'ng', channel: 'auto', ht: '20' }, { name: 'wifi1', radio: 'na', channel: 44, ht: 80 }],
    radio_table_stats: [
      { name: 'wifi0', radio: 'ng', channel: 6, bw: 20, cu_total: 18, cu_interf: 4, tx_power: 16, num_sta: 0 },
      { name: 'wifi1', radio: 'na', channel: 44, bw: 80, cu_total: 29, cu_interf: 8, tx_power: 20, num_sta: 0 },
    ],
  })]
}

export const MockScenario = z.enum([
  'reboot-ap', 'offline-switch', 'recover', 'downgrade-port', 'port-errors',
  'flap-port', 'new-device', 'roam', 'sticky', 'overheat', 'firmware-available',
])
type Scenario = z.infer<typeof MockScenario>
type MockStation = WireStation & { online: boolean }

export function createMockFleet(clients: Map<string, MockStation>, now: () => number, random: () => number) {
  const devices = buildMockDevices()
  const graph = createDeviceGraph(devices)
  const boot = new Map(devices.map(device => [device.mac, now() - (finiteNumber(device.uptime) ?? 0) * 1000]))
  const baseline = new Map(devices.map(device => [device.mac, structuredClone(device)]))
  const phone = [...clients.values()].find(client => client.hostname === 'alder-phone')!
  const home = { ap_mac: phone.ap_mac, channel: phone.channel, signal: phone.signal }
  let stickyUntil: number | null = null
  const restorePhone = () => { Object.assign(phone, home); stickyUntil = null }
  for (const device of devices) {
    if (![AP1, AP2, MESH_MAC].includes(device.mac)) continue
    device.vap_table = ['Home', 'IoT', 'Guest'].flatMap(essid =>
      ['ng', 'na'].map(radio => ({ essid, radio, ap_mac: device.mac, up: true, num_sta: 0 })))
  }
  const core = graph.byMac.get(SWITCH_MAC)!
  const ap = graph.byMac.get(AP1)!
  const port = (idx: number) => core.port_table!.find(row => row.port_idx === idx)!
  const clientPort = port(9)
  const baselinePort = () => baseline.get(SWITCH_MAC)!.port_table!.find(row => row.port_idx === 9)!
  const offline = new Set<string>()
  const powered = new Map<string, number>()
  let newDevices = 0
  const initializing = (mac: string) => (powered.get(mac) ?? 0) > now()
  let hot = false
  let errors = false

  const wiredPeers = new Map<WireDoc, number>()
  for (const client of clients.values()) {
    const attached = wiredAttachment(client)
    if (!client.online || !attached) continue
    const row = graph.byMac.get(attached.mac)?.port_table?.find(row => row.port_idx === attached.port)
    if (row?.up && !graph.downstream(attached.mac, attached.port ?? undefined).length) {
      const count = wiredPeers.get(row) ?? 0
      if (count === 0) row.last_connection = { connected: true, mac: client.mac, ip: client.ip, last_seen: client.last_seen }
      wiredPeers.set(row, count + 1)
      row.mac_table_count = count + 1
    }
  }
  port(14).mac_table_count = 3

  function activeClient(client: MockStation) {
    if (client === phone && stickyUntil !== null && now() >= stickyUntil) restorePhone()
    const attached = client.sw_mac ?? client.ap_mac
    return client.online && (!attached || !offline.has(attached) && !initializing(attached))
  }

  function reboot(macs: readonly string[]) {
    for (const mac of macs) if (graph.byMac.has(mac)) {
      boot.set(mac, now())
      const device = graph.byMac.get(mac)!
      device.uptime = 0
      if (device['system-stats']) device['system-stats'].uptime = '0'
    }
  }

  function addErrors() {
    clientPort.rx_errors = (finiteNumber(clientPort.rx_errors) ?? 0) + 180
    clientPort.tx_errors = (finiteNumber(clientPort.tx_errors) ?? 0) + 60
    clientPort.rx_packets = (finiteNumber(clientPort.rx_packets) ?? 0) + 1000
    clientPort.tx_packets = (finiteNumber(clientPort.tx_packets) ?? 0) + 600
  }

  function poll() {
    const at = now()
    for (const [mac, readyAt] of powered) {
      const device = graph.byMac.get(mac)!
      if (readyAt <= at) {
        reboot([mac])
        powered.delete(mac)
        device.state = 1
      } else device.state = 0
    }
    if (errors) addErrors()
    const active = [...clients.values()].filter(activeClient)
    const jitter = (value: unknown, scale: number) => {
      const base = finiteNumber(value)
      return base === null ? null : Math.max(0, base + (random() - 0.5) * scale)
    }
    for (const device of devices) {
      if (offline.has(device.mac) || initializing(device.mac)) continue
      const original = baseline.get(device.mac)!
      device.uptime = Math.max(0, Math.floor((at - boot.get(device.mac)!) / 1000))
      device.last_seen = Math.floor(at / 1000)
      device['system-stats'] = {
        ...device['system-stats'], uptime: String(device.uptime),
        cpu: jitter(original['system-stats']?.cpu, 9)?.toFixed(1) ?? null,
        mem: jitter(original['system-stats']?.mem, 3)?.toFixed(1) ?? null,
      }
      device.general_temperature = hot && device === ap ? 97 : jitter(original.general_temperature, 2)
      if (original.temperatures) device.temperatures = original.temperatures.map(temp => ({ ...temp, value: jitter(temp.value, 2) }))
      if (device.uplink) {
        device.uplink['rx_bytes-r'] = Math.round(jitter(original.uplink?.['rx_bytes-r'], 5000) ?? 0)
        device.uplink['tx_bytes-r'] = Math.round(jitter(original.uplink?.['tx_bytes-r'], 3000) ?? 0)
        if (device.mac === MESH_MAC) device.uplink.signal = Math.round(-66 + (random() - 0.5) * 6)
      }
      if (isGateway(device)) {
        for (const wan of ['wan1', 'wan2', 'wan3'] as const) if (device[wan]) {
          device[wan]['rx_bytes-r'] = Math.round(jitter(original[wan]?.['rx_bytes-r'], 1500) ?? 0)
          device[wan]['tx_bytes-r'] = Math.round(jitter(original[wan]?.['tx_bytes-r'], 600) ?? 0)
        }
      }
      const attached = active.filter(client => client.ap_mac === device.mac || client.sw_mac === device.mac)
      device.num_sta = attached.length
      for (const radio of device.radio_table_stats ?? []) radio.num_sta = attached.filter(client => client.radio === radio.radio).length
      for (const vap of device.vap_table ?? []) {
        vap.num_sta = attached.filter(client => client.essid === vap.essid && client.radio === vap.radio).length
      }
      let watts = 0
      for (const row of device.port_table ?? []) {
        const originalPort = original.port_table?.find(port => port.port_idx === row.port_idx)
        if (row.up === true) {
          row['rx_bytes-r'] = Math.round(jitter(originalPort?.['rx_bytes-r'], 8000) ?? 0)
          row['tx_bytes-r'] = Math.round(jitter(originalPort?.['tx_bytes-r'], 4000) ?? 0)
        }
        const baselineW = finiteNumber(originalPort?.poe_power)
        if (row.port_poe !== true || baselineW === null) continue
        const power = row.up && row.poe_mode !== 'off' && baselineW > 0 ? jitter(baselineW, 0.6)! : 0
        row.poe_power = power.toFixed(2)
        watts += power
      }
      if (device.total_max_power != null) device.total_used_power = Number(watts.toFixed(2))
    }
    return devices.filter(device => !offline.has(device.mac))
  }

  function setPortOverrides(id: string, entries: WireDoc[]) {
    const device = devices.find(row => row._id === id)
    if (!device) return
    device.port_overrides = entries
    for (const row of device.port_table ?? []) {
      const idx = portIndex(row.port_idx)
      if (idx === null || !poeCapable(row)) continue
      const original = baseline.get(device.mac)?.port_table?.find(port => portIndex(port.port_idx) === idx)
      const originalOverride = baseline.get(device.mac)?.port_overrides?.find(port => portIndex(port.port_idx) === idx)
      const target = entries.find(entry => portIndex(entry.port_idx) === idx)?.poe_mode
        ?? (originalOverride ? 'auto' : original?.poe_mode) ?? 'auto'
      const wasOff = row.poe_mode === 'off'
      row.poe_mode = target
      if (wasOff === (target === 'off')) continue
      const children = graph.descendants(device.mac, idx)
      if (!children.length) continue
      row.up = target !== 'off' && original?.up === true
      row.speed = row.up ? original?.speed : 0
      if (target === 'off') row.poe_power = '0.00'
      for (const child of children) {
        powered.set(child.mac, target === 'off' ? Infinity : now() + 60_000)
        child.state = 0
      }
    }
    return device

  }

  function scenario(kind: Scenario) {
    switch (kind) {
      case 'reboot-ap':
        reboot([AP1])
        return { mac: AP1, uptimeSec: ap.uptime }
      case 'offline-switch': {
        offline.add(SWITCH_MAC)
        for (const device of graph.descendants(SWITCH_MAC)) offline.add(device.mac)
        return { macs: [...offline] }
      }
      case 'recover': {
        offline.clear()
        hot = errors = false
        restorePhone()
        for (const key of ['speed', 'up', 'rx_errors', 'tx_errors', 'rx_packets', 'tx_packets', 'link_down_count']) {
          clientPort[key] = baselinePort()[key]
        }
        const spare = port(7)
        const initial = baseline.get(SWITCH_MAC)!.port_table!.find(row => row.port_idx === 7)!
        for (const key of ['up', 'speed', 'mac_table_count', 'last_connection']) spare[key] = initial[key]
        ap.general_temperature = baseline.get(AP1)?.general_temperature
        ap.upgradable = baseline.get(AP1)?.upgradable
        ap.upgrade_to_firmware = baseline.get(AP1)?.upgrade_to_firmware
        return { online: devices.filter(device => deviceState(device) === 'online').map(device => device.mac) }
      }
      case 'downgrade-port':
        clientPort.speed = 100
        return { mac: SWITCH_MAC, portIdx: 9, speedMbps: clientPort.speed }
      case 'port-errors':
        errors = true
        addErrors()
        return { mac: SWITCH_MAC, portIdx: 9, rxErrors: clientPort.rx_errors, txErrors: clientPort.tx_errors }
      case 'flap-port':
        clientPort.up = !clientPort.up
        clientPort.link_down_count = (finiteNumber(clientPort.link_down_count) ?? 0) + 5
        return { mac: SWITCH_MAC, portIdx: 9, up: clientPort.up, linkDownCount: clientPort.link_down_count }
      case 'new-device': {
        const row = port(7)
        const suffix = (++newDevices % 65_536).toString(16).padStart(4, '0').match(/../g)!.join(':')
        const mac = '02:00:00:90:' + suffix
        Object.assign(row, { up: true, speed: 1000, mac_table_count: 1, last_connection: { connected: true, mac } })
        return { switchMac: SWITCH_MAC, portIdx: 7, mac }
      }
      case 'roam': {
        stickyUntil = null
        phone.online = true
        const from = phone.ap_mac
        phone.ap_mac = from === AP2 ? AP1 : AP2
        phone.signal = from === AP2 ? -43 : -57
        phone.channel = from === AP2 ? 44 : 40
        phone.last_seen = Math.floor(now() / 1000)
        return { mac: phone.mac, from, to: phone.ap_mac }
      }
      case 'sticky':
        stickyUntil = now() + 10 * 60_000
        Object.assign(phone, { online: true, ap_mac: MESH_MAC, signal: -80, channel: 44 })
        return { mac: phone.mac, apMac: MESH_MAC, signal: phone.signal, until: stickyUntil }
      case 'overheat':
        hot = true
        ap.general_temperature = 97
        return { mac: AP1, tempC: ap.general_temperature }
      case 'firmware-available':
        ap.upgradable = true
        ap.upgrade_to_firmware = '8.9.0'
        return { mac: AP1, version: ap.upgrade_to_firmware }
    }
  }

  return { devices, activeClient, reboot, poll, scenario, graph, setPortOverrides }
}
