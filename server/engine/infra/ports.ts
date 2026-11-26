import type { PortPeerT, PortViewT } from '#shared/schemas/infra'
import { deviceMac, deviceName, finiteNumber, normalizePort } from '../../unifi/device-shape'
import type { WireDevice, WireDoc, WireStation } from '../../unifi/endpoints/schemas'
import { createDeviceGraph, createPoeSafety, lastPortConnection, wiredAttachment } from './poe-safety'

export function buildPortViews(device: WireDevice, graph: ReturnType<typeof createDeviceGraph>, stations: readonly WireStation[],
  safety: ReturnType<typeof createPoeSafety>, personByMac: ReadonlyMap<string, string>): PortViewT[] {
  const byMac = new Map(stations.map(station => [station.mac, station]))
  const clients = stations.filter(station => wiredAttachment(station)?.mac === device.mac)
  function peerFor(port: WireDoc, idx: number): PortPeerT | null {
    const peers = graph.downstream(device.mac, idx)
    const attached = clients.filter(client => wiredAttachment(client)?.port === idx)
    const lastConnection = lastPortConnection(port)
    const lastMac = lastConnection?.connected === false || port.up === false ? null : deviceMac(lastConnection?.mac)
    const macs = new Set([...peers.map(peer => peer.device.mac), ...attached.map(client => client.mac)])
    if (lastMac) macs.add(lastMac)
    const count = Math.max(macs.size, Math.floor(finiteNumber(port.mac_table_count) ?? 0))
    const child = peers.find(({ device }) => device.mac === lastMac) ?? peers[0]
    if (child) return { kind: 'device', mac: child.device.mac, name: deviceName(child.device), personId: null, count }
    const lastClient = lastMac ? byMac.get(lastMac) : undefined
    const client = attached.find(client => client.mac === lastMac) ?? attached[0]
      ?? (lastClient?.is_wired !== false && lastClient && !wiredAttachment(lastClient) ? lastClient : undefined)
    if (client) return { kind: 'client', mac: client.mac, name: client.name || client.hostname || client.mac,
      personId: personByMac.get(client.mac) ?? null, count }
    return count ? { kind: 'unknown', mac: lastMac, name: null, personId: null, count } : null
  }

  return (device.port_table ?? []).flatMap(port => {
    const view = normalizePort(device, port)
    if (!view) return []
    return [{ ...view, poeSafety: safety(device, port), peer: peerFor(port, view.idx),
      issues: [], baselineSpeedMbps: null, errorRatePct: null, flaps1h: 0 }]
  }).sort((a, b) => a.idx - b.idx)
}
