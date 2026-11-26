import { Topology, type InfraDeviceT, type PortViewT, type TopologyClientT, type TopologyEdgeT, type TopologyNodeT, type TopologyT } from '#shared/schemas/infra'
import type { EgressT } from '#shared/schemas/egress'
import { deviceMac, finiteNumber } from '../../unifi/device-shape'
import type { WireDevice, WireStation } from '../../unifi/endpoints/schemas'
import { portIndex } from '../../unifi/poe-ports'
import { bytesPerSecondToBps, wanRates, wanTelemetry } from '../../unifi/wan'
import { wiredAttachment } from './poe-safety'

type LinkPort = Pick<PortViewT, 'switchMac' | 'idx' | 'speedMbps' | 'maxSpeedMbps' | 'fullDuplex' | 'rxBps' | 'txBps' | 'poe' | 'issues'>
type ClientIdentity = Pick<TopologyClientT, 'name' | 'personId'>
type Devices = { devices: readonly InfraDeviceT[], ports: readonly LinkPort[], uplinkCaps?: ReadonlyMap<string, number> }
const deviceId = (mac: string) => 'dev:' + mac
const portKey = (mac: string, port: number) => mac + '/' + port
const positive = (value: number | null | undefined) => value != null && value > 0 ? value : null
const peopleIn = (members: TopologyClientT[]) => [...new Set(members.flatMap(client => client.personId ?? []))]

function edge(source: string, target: string, medium: TopologyEdgeT['medium'],
  telemetry: Partial<TopologyEdgeT> = {}): TopologyEdgeT {
  const speed = telemetry.speedMbps ?? null
  const rates = [telemetry.downBps, telemetry.upBps].flatMap(rate => rate ?? [])
  return {
    id: source + '->' + target, source, target, medium, speedMbps: null, maxSpeedMbps: null, fullDuplex: null,
    downBps: null, upBps: null, signal: null, parentPort: null, childPort: null, poeW: null, bottlenecks: [],
    ...telemetry, utilizationPct: speed && rates.length ? Math.max(...rates) / speed / 10_000 : null,
  }
}

export function deviceLinks({ devices, ports, uplinkCaps }: Devices) {
  const gateway = devices.find(device => device.type === 'gateway')
  if (!gateway) return { gateway, links: [], bottlenecks: [] }
  const byMac = new Map(devices.map(device => [device.mac, device]))
  const byPort = new Map(ports.map(port => [portKey(port.switchMac, port.idx), port]))
  const bottlenecks: TopologyT['bottlenecks'] = []

  function validParent(child: InfraDeviceT) {
    const parent = child.uplink?.mac && byMac.get(child.uplink.mac)
    if (!parent) return null
    const visited = new Set([child.mac])
    let upstream: InfraDeviceT | undefined = parent
    while (upstream && upstream !== gateway) {
      if (visited.has(upstream.mac)) return null
      visited.add(upstream.mac)
      upstream = upstream.uplink?.mac ? byMac.get(upstream.uplink.mac) : undefined
    }
    return parent
  }

  const links = devices.filter(child => child !== gateway).map(child => {
    const parent = validParent(child)
    if (!parent || !child.uplink) return edge(deviceId(gateway.mac), deviceId(child.mac), 'wire')
    const uplink = child.uplink
    const wireless = uplink.type === 'wireless'
    const parentPort = !wireless && uplink.remotePort !== null ? byPort.get(portKey(parent.mac, uplink.remotePort)) : undefined
    const childPort = !wireless && uplink.localPort !== null ? byPort.get(portKey(child.mac, uplink.localPort)) : undefined
    const childCap = childPort?.maxSpeedMbps ?? uplinkCaps?.get(child.mac)
    const caps = wireless ? [] : [parentPort?.maxSpeedMbps, childCap].flatMap(cap => positive(cap) ?? [])
    const link = edge(deviceId(parent.mac), deviceId(child.mac), wireless ? 'wireless' : 'wire', {
      speedMbps: positive(uplink.speedMbps) ?? positive(parentPort?.speedMbps),
      maxSpeedMbps: caps.length ? Math.min(...caps) : null, fullDuplex: uplink.fullDuplex ?? parentPort?.fullDuplex ?? null,
      downBps: parentPort?.txBps ?? uplink.rxBps, upBps: parentPort?.rxBps ?? uplink.txBps,
      signal: wireless ? uplink.signal : null, parentPort: wireless ? null : uplink.remotePort,
      childPort: wireless ? null : uplink.localPort, poeW: parentPort?.poe?.powerW ?? null,
    })
    if (link.speedMbps !== null && link.maxSpeedMbps !== null && link.speedMbps < link.maxSpeedMbps) link.bottlenecks.push('speed_below_capability')
    if (link.utilizationPct !== null && link.utilizationPct >= 80) link.bottlenecks.push('high_utilization')
    if (wireless && link.signal !== null && link.signal < -70) link.bottlenecks.push('weak_mesh')
    if (link.fullDuplex === false) link.bottlenecks.push('half_duplex')
    if (parentPort?.issues.includes('errors')) link.bottlenecks.push('errors')

    for (const kind of link.bottlenecks) bottlenecks.push({
      edgeId: link.id, kind, messageKey: 'topology.bottleneck.' + kind,
      messageParams: {
        parent: parent.name, child: child.name, speed: String(link.speedMbps ?? ''), max: String(link.maxSpeedMbps ?? ''),
        util: link.utilizationPct?.toFixed(1) ?? '', signal: String(link.signal ?? ''),
      },
    })
    return link
  })
  return { gateway, links, bottlenecks }
}

export function buildTopology(input: Devices & {
  activeClients: readonly WireStation[]
  identity: ReadonlyMap<string, ClientIdentity>
  egresses: readonly EgressT[]
  gatewayTelemetry?: WireDevice | null
  at: number
}): TopologyT {
  const { devices, activeClients, identity, egresses, gatewayTelemetry, at } = input
  const { gateway, links, bottlenecks } = deviceLinks(input)
  if (!gateway) return { generatedAt: at, nodes: [], edges: [], bottlenecks: [] }
  const edges = [...links]
  const byMac = new Map(devices.map(device => [device.mac, device]))
  const byChild = new Map(links.map(link => [link.target, link]))
  const groups = new Map<string, { parent: string, port: number | null, members: TopologyClientT[] }>()
  for (const device of devices) {
    if (device.type === 'ap') groups.set('clients:' + device.mac, { parent: deviceId(device.mac), port: null, members: [] })
  }
  for (const station of activeClients) {
    if (byMac.has(station.mac)) continue
    const apMac = station.is_wired === true ? null : deviceMac(station.ap_mac)
    const wired = apMac ? null : wiredAttachment(station)
    const parent = byMac.get(apMac ?? wired?.mac ?? '')
    const port = wired?.port ?? null
    if (!parent || (wired ? (port === null || parent.type !== 'switch' && parent.type !== 'gateway') : parent.type !== 'ap')) continue
    const parentId = deviceId(parent.mac)
    const id = 'clients:' + parent.mac + (port === null ? '' : ':' + port)
    const group = groups.get(id) ?? { parent: parentId, port, members: [] }
    const client = identity.get(station.mac)
    group.members.push({
      mac: station.mac, name: client?.name ?? (station.name || station.hostname || station.mac), personId: client?.personId ?? null,
      wired: port !== null, signal: port === null ? station.signal ?? null : null,
      rxBps: bytesPerSecondToBps(station['rx_bytes-r']), txBps: bytesPerSecondToBps(station['tx_bytes-r']),
    })
    groups.set(id, group)
  }

  const direct = new Map<string, TopologyClientT[]>()
  const groupNodes: TopologyNodeT[] = []
  const sumRates = (members: TopologyClientT[], direction: 'rxBps' | 'txBps') => {
    const rates = members.flatMap(member => member[direction] ?? [])
    return rates.length ? rates.reduce((total, rate) => total + rate, 0) : null
  }
  for (const [id, { parent, port, members }] of groups) {
    direct.set(parent, [...direct.get(parent) ?? [], ...members])
    const device = byMac.get(parent.slice(4))!
    groupNodes.push({
      id, kind: 'client_group', label: port !== null ? device.name + ' · ' + port : device.name, parentId: parent,
      mac: null, egressId: null, model: null, state: device.state === 'offline' ? 'down' : 'ok', clients: members.length, people: peopleIn(members), poeW: null, members,
    })
    edges.push(edge(parent, id, port === null ? 'wireless' : 'wire', {
      parentPort: port, downBps: sumRates(members, 'rxBps'), upBps: sumRates(members, 'txBps'),
    }))
  }

  const nodes: TopologyNodeT[] = [gateway, ...devices.filter(device => device !== gateway)].map(device => {
    const id = deviceId(device.mac)
    const link = byChild.get(id)
    const members = direct.get(id) ?? []
    return {
      id, kind: device === gateway || device.type !== 'gateway' ? device.type : 'other', label: device.name, parentId: link?.source ?? null,
      mac: device.mac, egressId: null, model: device.model, clients: device.clients ?? members.length,
      state: device.state === 'offline' ? 'down' : device.issues.some(issue => issue.severity !== 'info') || link?.bottlenecks.length ? 'warning' : 'ok',
      people: peopleIn(members), poeW: device.type === 'switch' ? device.poe?.usedW ?? null : null, members: [],
    }
  })
  for (const egress of egresses) {
    const id = 'egress:' + egress.id
    const parentId = deviceId(gateway.mac)
    const state = { healthy: 'ok', degraded: 'warning', down: 'down', unknown: 'unknown' } as const
    nodes.push({ id, kind: 'egress', egressId: egress.id, label: egress.name, parentId, mac: null,
      model: null, state: state[egress.health.status], clients: 0, people: [], poeW: null, members: [] })
    const wan = egress.kind === 'wan'
    const uplink = wan ? wanTelemetry(gatewayTelemetry, egress.wanGroup) : null
    const { rxBps, txBps } = wanRates(uplink)
    edges.push(edge(parentId, id, wan ? 'wan' : 'vpn', {
      speedMbps: positive(finiteNumber(uplink?.speed)), parentPort: portIndex(uplink?.port_idx),
      fullDuplex: typeof uplink?.full_duplex === 'boolean' ? uplink.full_duplex : null, downBps: txBps, upBps: rxBps,
    }))
  }
  return Topology.parse({ generatedAt: at, nodes: [...nodes, ...groupNodes], edges, bottlenecks })
}
