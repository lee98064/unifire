import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { InfraDevice, InfraDeviceDetail, type InfraDeviceT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import type { Db } from '../../db'
import { deviceTransitions, infraDevices, personDevices } from '../../db/schema'
import type { ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { deviceName, deviceRadios, deviceType, normalizeDevice } from '../../unifi/device-shape'
import type { WireDevice } from '../../unifi/endpoints/schemas'
import { UnifiError } from '../../unifi/errors'
import { DAY } from '../access-time'
import { availabilityByDevice, deviceEvents } from './device-history'
import { createDeviceGraph, createPoeSafety } from './poe-safety'
import { buildPortViews } from './ports'

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
  availability24h: number | null, config: SettingsT['infra'], at: number): InfraDeviceT {
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
    ports: reading?.ports ?? null, poe: reading?.poe ? { ...reading.poe, usedW: live?.poe?.usedW ?? null } : null,
    bands: reading?.bands ?? [], availability24h, lastReboot: latest ? { ts: latest.ts, unexpected: latest.reason === 'unexpected_reboot' } : null,
    locating: saved.locateUntil !== null && saved.locateUntil > at,
  }
  const issues = deviceIssues(device, config, at)
  if (latest && latest.reason !== 'unexpected_reboot' && !issues.some(issue => issue.kind === 'unexpected_reboot')) {
    const earlier = db.select({ id: deviceTransitions.id }).from(deviceTransitions).where(and(eq(deviceTransitions.mac, saved.mac),
      eq(deviceTransitions.reason, 'unexpected_reboot'), gte(deviceTransitions.ts, at - DAY))).limit(1).get()
    if (earlier) issues.push({ kind: 'unexpected_reboot', severity: 'warning', messageKey: 'infra.issue.unexpected_reboot', messageParams: {} })
  }
  return InfraDevice.parse({ ...device, issues })
}

export function listInfraDevices(db: Db, service: ControllerService, at: number, mac?: string) {
  const runtime = service.runtime
  if (!runtime) return []
  const readings = new Map(runtime.cache.snapshot().devices.filter(row => row.adopted !== false).map(row => [row.mac, row]))
  const config = createSettingsService(db).get().infra
  const availability = availabilityByDevice(db, runtime.scope, at)
  return db.select().from(infraDevices)
    .where(and(eq(infraDevices.scope, runtime.scope), mac === undefined ? undefined : eq(infraDevices.mac, mac)))
    .orderBy(infraDevices.type, infraDevices.name, infraDevices.mac).all()
    .map(row => deviceView(db, row, readings.get(row.mac), availability.get(row.mac) ?? null, config, at))
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
  const events = deviceEvents(db, mac, undefined, undefined, 50)
  return InfraDeviceDetail.parse({ ...view,
    ports: wire ? buildPortViews(wire, graph, stations, safety, personByMac) : [],
    radios: wire ? deviceRadios(wire) : [],
    downstream: graph.downstream(mac).map(({ device, viaPort }) => ({ mac: device.mac, name: deviceName(device), type: deviceType(device), viaPort })),
    transitions: events.transitions, firmwareHistory: events.firmware, portEvents: events.portEvents, roams24h: null, energy: null })
}

export function infraDashboard(db: Db, service: ControllerService, at: number) {
  const devices = listInfraDevices(db, service, at)
  const watts = devices.flatMap(device => device.poe?.usedW ?? [])
  return {
    total: devices.length,
    online: devices.filter(device => device.state === 'online').length,
    offline: devices.filter(device => device.state === 'offline').length,
    withIssues: devices.filter(device => device.issues.some(issue => issue.severity !== 'info')).length,
    portEvents: 0, poeWatts: watts.length ? watts.reduce((sum, w) => sum + w, 0) : null, openIncidents: 0,
  }
}
