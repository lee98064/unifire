import type { PortPeerT, PortViewT } from '#shared/schemas/infra'
import { deviceMac, deviceName, deviceUplink, finiteNumber, normalizePort } from '../../unifi/device-shape'
import type { WireDevice, WireDoc, WireStation } from '../../unifi/endpoints/schemas'
import { createDeviceGraph, createPoeSafety, lastPortConnection, wiredAttachment } from './poe-safety'

export function readPorts(device: WireDevice, graph: ReturnType<typeof createDeviceGraph>, stations: readonly WireStation[],
  safety: ReturnType<typeof createPoeSafety>, personByMac: ReadonlyMap<string, string>,
  firstSeen: ReadonlyMap<string, number> = new Map()) {
  const byMac = new Map(stations.map(station => [station.mac, station]))
  const clients = stations.flatMap(station => {
    const edge = wiredAttachment(station)
    return edge?.mac === device.mac ? [{ station, port: edge.port }] : []
  })
  const upstream = deviceUplink(device)
  return (device.port_table ?? []).flatMap(raw => {
    const port = normalizePort(device, raw)
    if (!port) return []
    const children = graph.downstream(device.mac, port.idx)
    const attached = clients.filter(client => client.port === port.idx).map(client => client.station)
    const last = lastPortConnection(raw)
    const lastMac = deviceMac(last?.mac)
    const lastCurrent = last?.connected !== false && port.up ? lastMac : null
    const count = Math.max(attached.length, Math.floor(finiteNumber(raw.mac_table_count) ?? 0))
    const peers = new Map<string, PortPeerT & { mac: string }>()
    const adopt = (mac: string, name: string | null) =>
      peers.set(mac, { kind: 'device', mac, name, personId: null, count: Math.max(1, count) })
    const stationPeer = (station: WireStation) => peers.set(station.mac, {
      kind: 'client', mac: station.mac, name: station.name || station.hostname || station.mac,
      personId: personByMac.get(station.mac) ?? null, count: Math.max(1, count),
    })
    if (port.isUplink && upstream?.mac) {
      const parent = graph.byMac.get(upstream.mac)
      adopt(upstream.mac, parent ? deviceName(parent) : upstream.name)
    }
    for (const { device: child } of children) adopt(child.mac, deviceName(child))
    for (const station of attached) if (!peers.has(station.mac)) stationPeer(station)
    if (lastMac && !peers.has(lastMac)) {
      const known = byMac.get(lastMac)
      if (known) stationPeer(known)
      else peers.set(lastMac, { kind: 'unknown', mac: lastMac, name: null, personId: null, count: Math.max(1, count) })
    }
    const oldest = count > 1 ? [...attached].sort((a, b) => {
      const seen = (station: WireStation) => firstSeen.get(port.idx + '/' + station.mac)
        ?? (station.first_seen == null ? Infinity : station.first_seen * 1000)
      return seen(a) - seen(b) || a.mac.localeCompare(b.mac)
    })[0]?.mac : attached[0]?.mac
    const primary = (port.isUplink ? upstream?.mac : null)
      ?? (count > 1 && port.up ? lastMac : null)
      ?? children.find(child => child.device.mac === lastCurrent)?.device.mac ?? children[0]?.device.mac
      ?? attached.find(client => client.mac === lastCurrent)?.mac ?? oldest ?? lastCurrent
    const peer = primary ? peers.get(primary) ?? null
      : count ? { kind: 'unknown' as const, mac: null, name: null, personId: null, count } : null
    const view: PortViewT = { ...port, poeSafety: safety(device, raw), peer,
      issues: [], baselineSpeedMbps: null, errorRatePct: null, flaps1h: 0 }
    return [{ raw, view, peers: [...peers.values()], lastMac, lastCurrent,
      lastSeen: finiteNumber(last?.last_seen), downstream: children.length > 0 }]
  }).sort((a, b) => a.view.idx - b.view.idx)
}

export function buildPortViews(...args: Parameters<typeof readPorts>) {
  return readPorts(...args).map(row => row.view)
}
