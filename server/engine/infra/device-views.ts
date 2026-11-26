import { and, desc, eq, gte, inArray, count } from 'drizzle-orm'
import { InfraDevice, InfraDeviceDetail, type InfraDeviceT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import type { Db } from '../../db'
import { deviceTransitions, infraDevices, personDevices, portEvents, portPeers } from '../../db/schema'
import type { ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { deviceName, deviceRadios, deviceType, finiteNumber, normalizeDevice, normalizePort } from '../../unifi/device-shape'
import type { WireDevice } from '../../unifi/endpoints/schemas'
import { UnifiError } from '../../unifi/errors'
import { DAY } from '../access-time'
import { availabilityByDevice, deviceEvents } from './device-history'
import { createDeviceGraph, createPoeSafety } from './poe-safety'
import { deviceEnergy, liveWatts } from './energy'
import { enrichPort, portIssues } from './port-health'
import { buildPortViews } from './ports'
import { apRoams24h } from './roaming'
import { deviceLinks } from './topology'

const rebootReasons = ['unexpected_reboot', 'unifire_restart', 'upgrade'] as const

export function deviceIssues(device: Pick<InfraDeviceT, 'state' | 'tempC' | 'cpuPct' | 'memPct' | 'upgradeTo' | 'lastReboot'>,
  settings: SettingsT['infra'], at: number): InfraDeviceT['issues'] {
  const { state, tempC, cpuPct, memPct, upgradeTo, lastReboot } = device
  const issues: InfraDeviceT['issues'] = []
  function add(kind: InfraDeviceT['issues'][number]['kind'], severity: InfraDeviceT['issues'][number]['severity'],
    messageParams: Record<string, string> = {}) {
    issues.push({ kind, severity, messageKey: `infra.issue.${kind}`, messageParams })
  }
  if (state === 'offline') add('offline', 'error')
  if (tempC !== null && tempC >= settings.tempWarnC) add('overheat', 'warning', { temp: String(tempC) })
  if (cpuPct !== null && cpuPct >= settings.cpuWarnPct) add('high_cpu', 'warning', { cpu: String(cpuPct) })
  if (memPct !== null && memPct >= settings.memWarnPct) add('high_mem', 'warning', { mem: String(memPct) })
  if (upgradeTo) add('firmware_available', 'info', { version: upgradeTo })
  if (lastReboot?.unexpected && lastReboot.ts >= at - DAY) add('unexpected_reboot', 'warning')
  return issues
}

function deviceView(db: Db, saved: typeof infraDevices.$inferSelect, wire: WireDevice | undefined,
  availability24h: number | null, affectedPorts: number, config: SettingsT['infra'], at: number): InfraDeviceT {
  const reading = wire && normalizeDevice(wire)
  const live = saved.lastState !== 'offline' ? reading : undefined
  const latest = db.select({ ts: deviceTransitions.ts, reason: deviceTransitions.reason }).from(deviceTransitions)
    .where(and(eq(deviceTransitions.mac, saved.mac), inArray(deviceTransitions.reason, rebootReasons)))
    .orderBy(desc(deviceTransitions.ts), desc(deviceTransitions.id)).limit(1).get()
  const device = {
    mac: saved.mac, unifiId: saved.unifiId, name: saved.name, model: saved.model, modelName: saved.modelName,
    type: saved.type, state: saved.lastState, firmware: saved.firmware, upgradeTo: saved.upgradeTo,
    firstSeen: saved.firstSeen, lastSeen: saved.lastSeen, roomId: saved.roomId,
    ip: reading?.ip ?? null, uptimeSec: live?.uptimeSec ?? null, cpuPct: live?.cpuPct ?? null,
    memPct: live?.memPct ?? null, tempC: live?.tempC ?? null, clients: live?.clients ?? null,
    rxBps: live?.rxBps ?? null, txBps: live?.txBps ?? null, uplink: reading?.uplink ?? null,
    ports: reading?.ports ? { ...reading.ports, issues: affectedPorts } : null, poe: reading?.poe ? { ...reading.poe, usedW: live?.poe?.usedW ?? null } : null,
    bands: reading?.bands ?? [], availability24h, lastReboot: latest ? { ts: latest.ts, unexpected: latest.reason === 'unexpected_reboot' } : null,
    locating: saved.locateUntil !== null && saved.locateUntil > at,
  }
  const issues = deviceIssues(device, config, at)
  if (affectedPorts) issues.push({ kind: 'port_issue', severity: 'warning', messageKey: 'infra.issue.port_issue',
    messageParams: { count: String(affectedPorts) } })
  if (latest && latest.reason !== 'unexpected_reboot' && !issues.some(issue => issue.kind === 'unexpected_reboot')) {
    const earlier = db.select({ id: deviceTransitions.id }).from(deviceTransitions).where(and(eq(deviceTransitions.mac, saved.mac),
      eq(deviceTransitions.reason, 'unexpected_reboot'), gte(deviceTransitions.ts, at - DAY))).limit(1).get()
    if (earlier) issues.push({ kind: 'unexpected_reboot', severity: 'warning', messageKey: 'infra.issue.unexpected_reboot', messageParams: {} })
  }
  return InfraDevice.parse({ ...device, issues })
}

export function topologyDeviceInputs(db: Db, service: ControllerService, at: number) {
  const runtime = service.runtime
  if (!runtime) return { devices: [], ports: [], uplinkCaps: new Map<string, number>() }
  const readings = new Map(runtime.cache.snapshot().devices.filter(row => row.adopted !== false).map(row => [row.mac, row]))
  const config = createSettingsService(db).get().infra
  const availability = availabilityByDevice(db, runtime.scope, at)
  const issues = portIssues(db, runtime.scope, config, at)
  const affected = new Map<string, number>()
  for (const key of issues.keys()) {
    const mac = key.split('/')[0]!
    affected.set(mac, (affected.get(mac) ?? 0) + 1)
  }
  const devices = db.select().from(infraDevices)
    .where(eq(infraDevices.scope, runtime.scope))
    .orderBy(infraDevices.type, infraDevices.name, infraDevices.mac).all()
    .map(row => deviceView(db, row, readings.get(row.mac), availability.get(row.mac) ?? null, affected.get(row.mac) ?? 0, config, at))
  const uplinkCaps = new Map<string, number>()
  const ports = [...readings.values()].flatMap(device => {
    const cap = finiteNumber(device.uplink?.max_speed)
    if (cap !== null && cap > 0) uplinkCaps.set(device.mac, cap)
    return (device.port_table ?? []).flatMap(raw => {
      const port = normalizePort(device, raw)
      return port ? [{ ...port, issues: issues.get(device.mac + '/' + port.idx) ?? [] }] : []
    })
  })
  return { devices, ports, uplinkCaps }
}

export function listInfraDevices(db: Db, service: ControllerService, at: number, mac?: string) {
  const inputs = topologyDeviceInputs(db, service, at)
  const { links } = deviceLinks(inputs)
  const flagged = new Set(links.filter(link => link.bottlenecks.length).map(link => link.target.slice(4)))
  return inputs.devices.filter(device => mac === undefined || device.mac === mac).map(device => {
    if (flagged.has(device.mac)) device.issues.push({
      kind: 'bottleneck', severity: 'warning', messageKey: 'infra.issue.bottleneck', messageParams: {},
    })
    return device
  })
}

export function infraDeviceDetail(db: Db, service: ControllerService, mac: string, at: number) {
  const view = listInfraDevices(db, service, at, mac)[0]
  if (!view) throw new UnifiError('DEVICE_NOT_FOUND', 404)
  const snapshot = service.runtime?.cache.snapshot()
  const graph = createDeviceGraph(snapshot?.devices ?? [])
  const wire = graph.byMac.get(mac)
  const stations = snapshot?.activeClients ?? []
  const status = service.status()
  const safety = createPoeSafety(graph, stations, { mac: status.selfMac, ip: status.selfIp })
  const personByMac = new Map(db.select().from(personDevices).all().map(row => [row.mac, row.personId]))
  const scope = service.runtime!.scope
  const events = deviceEvents(db, mac, undefined, undefined, 50)
  const config = createSettingsService(db).get()
  const issues = portIssues(db, scope, config.infra, at)
  const firstSeen = new Map(db.select().from(portPeers).where(and(eq(portPeers.scope, scope), eq(portPeers.switchMac, mac)))
    .all().map(row => [row.portIdx + '/' + row.mac, row.firstSeen]))
  return InfraDeviceDetail.parse({ ...view,
    ports: wire ? buildPortViews(wire, graph, stations, safety, personByMac, firstSeen)
      .map(port => enrichPort(db, { scope, switchMac: mac, portIdx: port.idx }, port, at, issues.get(mac + '/' + port.idx) ?? [])) : [],
    radios: wire ? deviceRadios(wire) : [],
    downstream: graph.downstream(mac).map(({ device, viaPort }) => ({ mac: device.mac, name: deviceName(device), type: deviceType(device), viaPort })),
    transitions: events.transitions, firmwareHistory: events.firmware, portEvents: events.portEvents, roams24h: view.type === 'ap' ? apRoams24h(db, scope, mac, at) : null, energy: view.poe ? deviceEnergy(db, scope, mac, at, config.timezone) : null })
}

export function infraDashboard(db: Db, service: ControllerService, at: number) {
  const devices = listInfraDevices(db, service, at)
  const scope = service.runtime?.scope
  const unacknowledged = scope ? db.select({ total: count() }).from(portEvents)
    .where(and(eq(portEvents.scope, scope), eq(portEvents.acknowledged, false))).get()?.total ?? 0 : 0
  return {
    total: devices.length,
    online: devices.filter(device => device.state === 'online').length,
    offline: devices.filter(device => device.state === 'offline').length,
    withIssues: devices.filter(device => device.issues.some(issue => issue.severity !== 'info')).length,
    portEvents: unacknowledged, poeWatts: liveWatts(service), openIncidents: 0,
  }
}
