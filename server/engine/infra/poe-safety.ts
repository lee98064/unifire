import type { PoeSafetyReasonT, PortViewT } from '#shared/schemas/infra'
import { deviceMac, deviceType, deviceUplink, isGateway } from '../../unifi/device-shape'
import { Doc, type WireDevice, type WireDoc, type WireStation } from '../../unifi/endpoints/schemas'
import { isUplink, poeCapable, portIndex } from '../../unifi/poe-ports'

type Attachment = { mac: string, port: number | null, localPort?: number | null }

export function lastPortConnection(port: WireDoc) {
  return Doc.safeParse(port.last_connection).data
}

export function wiredAttachment(client: WireStation): Attachment | null {
  if (client.is_wired === false || (client.is_wired !== true && client.ap_mac && !client.sw_mac)) return null
  const mac = deviceMac(client.sw_mac ?? client.last_uplink_mac)
  return mac ? { mac, port: portIndex(client.sw_port ?? client.last_uplink_remote_port) } : null
}

export function createDeviceGraph(devices: readonly WireDevice[]) {
  const byMac = new Map(devices.filter(row => row.adopted !== false).map(row => [row.mac, row]))
  const parent = new Map<string, Attachment>()
  function attach(child: string | null, edge: Attachment) {
    if (!child || child === edge.mac || !byMac.has(child) || isGateway(byMac.get(child)!)) return
    const existing = parent.get(child)
    if (!existing) parent.set(child, edge)
    else if (existing.mac === edge.mac && existing.port === null && edge.port !== null) {
      parent.set(child, { ...existing, port: edge.port })
    }
  }

  for (const device of byMac.values()) {
    const uplink = deviceUplink(device)
    if (uplink?.mac) attach(device.mac, { mac: uplink.mac, port: uplink.remotePort, localPort: uplink.localPort })
  }
  for (const device of byMac.values()) {
    for (const link of device.downlink_table ?? []) {
      attach(deviceMac(link.mac), { mac: device.mac, port: portIndex(link.port_idx) })
    }
  }
  for (const device of byMac.values()) {
    for (const port of device.port_table ?? []) {
      if (port.up === false || isUplink(device, port)) continue
      const peer = lastPortConnection(port)
      if (peer?.connected !== false) attach(deviceMac(peer?.mac), { mac: device.mac, port: portIndex(port.port_idx) })
    }
  }
  const children = new Map<string, { device: WireDevice, viaPort: number | null }[]>()
  for (const [mac, edge] of parent) {
    const peers = children.get(edge.mac) ?? []
    peers.push({ device: byMac.get(mac)!, viaPort: edge.port })
    children.set(edge.mac, peers)
  }

  const downstream = (mac: string, port?: number) => (children.get(mac) ?? [])
    .filter(child => port === undefined || child.viaPort === port)
  function descendants(mac: string, port?: number) {
    const result: WireDevice[] = []
    const visited = new Set([mac])
    const queue = downstream(mac, port).map(child => child.device)
    while (queue.length) {
      const device = queue.pop()!
      if (visited.has(device.mac)) continue
      visited.add(device.mac)
      result.push(device)
      for (const child of downstream(device.mac)) queue.push(child.device)
    }
    return result
  }
  return { byMac, parent, downstream, descendants }
}

export function createPoeSafety(graph: ReturnType<typeof createDeviceGraph>, clients: readonly WireStation[],
  self: { mac: string | null, ip: string | null }) {
  const isSelf = (mac: unknown, ip: unknown) => (self.mac !== null && deviceMac(mac) === self.mac)
    || (self.ip !== null && ip === self.ip)
  const attachments: Attachment[] = []
  for (const client of clients) {
    if (!isSelf(client.mac, client.ip)) continue
    const ap = deviceMac(client.ap_mac)
    const attachment = wiredAttachment(client) ?? (ap ? { mac: ap, port: null } : null)
    if (attachment) attachments.push(attachment)
  }
  for (const device of graph.byMac.values()) {
    for (const port of device.port_table ?? []) {
      if (port.up === false || isUplink(device, port)) continue
      const peer = lastPortConnection(port)
      if (peer && peer.connected !== false && isSelf(peer.mac, peer.ip)) {
        attachments.push({ mac: device.mac, port: portIndex(port.port_idx) })
      }
    }
  }

  const hostPorts = new Set<string>()
  const gatewayPorts = new Set<string>()
  const portKey = (mac: string, idx: number) => `${mac}/${idx}`
  for (const attachment of attachments) {
    const path: string[] = []
    const visited = new Set<string>()
    let edge: Attachment | undefined = attachment
    while (edge && !visited.has(edge.mac)) {
      visited.add(edge.mac)
      if (edge.port !== null) {
        const key = portKey(edge.mac, edge.port)
        path.push(key)
        hostPorts.add(key)
      }
      const device = graph.byMac.get(edge.mac)
      if (!device) break
      if (isGateway(device)) {
        for (const key of path) gatewayPorts.add(key)
        break
      }
      const parent = graph.parent.get(edge.mac)
      if (parent?.localPort != null) path.push(portKey(edge.mac, parent.localPort))
      edge = parent
    }
  }

  return (device: WireDevice, port: WireDoc): PortViewT['poeSafety'] => {
    const reasons: PoeSafetyReasonT[] = []
    const capable = poeCapable(port)
    const idx = portIndex(port.port_idx)
    const peers = idx === null ? [] : graph.downstream(device.mac, idx)
    if (!capable) reasons.push('not_poe')
    if (isUplink(device, port)) reasons.push('uplink')
    // A child AP is safe to acknowledge only if it does not provide uplink to another adopted device.
    if (idx !== null && graph.descendants(device.mac, idx).some(peer => {
      const type = deviceType(peer)
      return type !== 'ap' || graph.downstream(peer.mac).length > 0
    })) {
      reasons.push('downstream_devices')
    }
    if (idx !== null && hostPorts.has(portKey(device.mac, idx))) reasons.push('unifire_host')
    if (idx !== null && gatewayPorts.has(portKey(device.mac, idx))) reasons.push('gateway_path')
    const requiresAck = peers.some(({ device: peer }) => deviceType(peer) === 'ap')
    if (requiresAck) reasons.push('powers_ap')
    return { allowed: capable && reasons.every(reason => reason === 'powers_ap'), reasons, requiresAck }
  }
}
