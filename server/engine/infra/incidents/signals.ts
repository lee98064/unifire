import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm'
import type { IncidentSignalKindT, IncidentSignalT, IncidentT } from '#shared/schemas/infra'
import type { AuditEventT } from '#shared/schemas/insight'
import type { Db } from '../../../db'
import { deviceSamples, egresses, egressHealth, incidentWanState, infraDevices, personDevices } from '../../../db/schema'
import { createAuditService } from '../../../services/audit'
import type { ControllerService } from '../../../services/controller'
import { createSettingsService } from '../../../services/settings'
import { deviceMac } from '../../../unifi/device-shape'
import type { WireStation } from '../../../unifi/endpoints/schemas'
import type { ControllerEvent } from '../../../unifi/ws'
import { liveBus } from '../../../utils/bus'
import { DAY, MINUTE } from '../../access-time'
import { topologyDeviceInputs } from '../device-views'
import { createDeviceGraph, deviceAncestors, lastKnownParents, wiredAttachment } from '../poe-safety'
import { plannedPoePorts, plannedPower } from '../poe-state'
import { deviceLinks } from '../topology'
import { recoveryState, type Signal, type SignalFacts } from './correlate'
import { createIncidentStore } from './store'

const clientWindow = 2 * MINUTE
const configCategories = new Set(['config', 'route', 'wifi', 'poe', 'device'])
const system = { type: 'system', id: null, name: null } as const
const errorKinds = new Set<IncidentSignalKindT>(['egress_down', 'wan_down', 'device_offline', 'uplink_down', 'mass_disconnect'])
const deviceKey = (mac: string) => 'device/' + mac
const rebootKey = (mac: string) => 'reboot/' + mac
const massKey = (mac: string) => 'mass/' + mac
const portKey = (mac: string, idx: number) => 'port/' + mac + '/' + idx
const linkKey = (mac: string, peer: string) => 'link/' + [mac, peer].sort().join('/')
const deviceOf = (row: WireStation) => (row.is_wired === true ? null : deviceMac(row.ap_mac)) ?? wiredAttachment(row)?.mac

function makeSignal(kind: IncidentSignalKindT, ts: number, ref: IncidentSignalT['ref'], facts: SignalFacts,
  port = '', count = '', ago = ''): Signal {
  return { id: randomUUID(), kind, ts, ref, facts, suspect: false,
    severity: errorKinds.has(kind) ? 'error' : 'warning',
    messageKey: 'incident.signal.' + kind, messageParams: { name: ref?.label ?? '', port, count, ago } }
}

type Runtime = NonNullable<ControllerService['runtime']>
type Loss = { station: WireStation, at: number }

export function createIncidentEngine(db: Db, service: ControllerService, now = Date.now, bus = liveBus) {
  const settings = createSettingsService(db)
  const audit = createAuditService(db, bus, now)
  const online = new Map<string, WireStation>()
  const departures = new Map<string, Loss>()
  let runtime: Runtime | undefined
  let leased = () => false
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let nextPrune = 0
  let flushQueued = false

  const emit = (event: ControllerEvent) => service.engine.emit('event', event)
  function refreshScope() {
    const next = service.runtime
    if (runtime !== next) {
      runtime = next
      online.clear()
      departures.clear()
      for (const station of next?.cache.snapshot().activeClients ?? []) online.set(station.mac, station)
    }
    return leased() && runtime?.active() ? runtime : undefined
  }

  function exits(run: Runtime) {
    return db.select().from(egresses).where(and(eq(egresses.site, run.config.site), eq(egresses.enabled, true))).all()
  }

  function planned(run: Runtime, at: number) {
    const graph = createDeviceGraph(run.cache.snapshot().devices)
    const saved = db.select({ mac: infraDevices.mac, lastUplink: infraDevices.lastUplink })
      .from(infraDevices).where(eq(infraDevices.scope, run.scope)).all()
    const parents = lastKnownParents(graph.parent, saved)
    const ports = plannedPoePorts(db, run.scope, at, graph)
    const device = (mac: string) => plannedPower(mac, parents, ports) !== undefined
    const port = (mac: string, idx: number) => ports.has(mac + '/' + idx)
      || parents.get(mac)?.localPort === idx && device(mac)
    const client = (station: WireStation) => {
      const mac = deviceOf(station)
      const wired = wiredAttachment(station)
      return mac !== undefined && device(mac) || wired?.port != null && port(wired.mac, wired.port)
    }
    return { device, port, client, adopted: (mac: string) => graph.byMac.has(mac) || saved.some(row => row.mac === mac) }
  }

  function context(run: Runtime, at: number) {
    const inputs = topologyDeviceInputs(db, service, at)
    const { gateway, links } = deviceLinks(inputs)
    const parent = new Map(links.map(link => [link.target.slice(4), { mac: link.source.slice(4) }]))
    const nodes = new Map(inputs.devices.map(device => [device.mac, { device, ancestors: deviceAncestors(device.mac, parent) }]))
    const people = new Map(db.select().from(personDevices).where(eq(personDevices.presence, true)).all()
      .map(row => [row.mac, row.personId]))
    const power = planned(run, at)
    const recent = new Map(online)
    for (const { station, at: ts } of departures.values()) {
      if (ts >= at - clientWindow && !recent.has(station.mac)) recent.set(station.mac, station)
    }
    const clients = new Map<string, { count: number, people: Set<string>, groups: Set<string> }>()
    for (const [mac, station] of recent) {
      const uplink = deviceOf(station)
      if (!uplink || nodes.has(mac) || power.client(station)) continue
      const group = clients.get(uplink) ?? { count: 0, people: new Set<string>(), groups: new Set<string>() }
      const person = people.get(mac)
      const port = wiredAttachment(station)?.port
      const groupId = port != null ? `clients:${uplink}:${port}` : 'clients:' + uplink
      group.count++
      if (person) group.people.add(person)
      group.groups.add(groupId)
      clients.set(uplink, group)
    }
    const baseline = [...recent.keys()].filter(mac => !nodes.has(mac)).length
    return {
      baseline,
      power,
      hasDevice: (mac: string) => nodes.has(mac),
      ref(mac: string) {
        return { type: 'device' as const, id: mac, label: nodes.get(mac)?.device.name ?? mac }
      },
      facts(mac: string, affected = false): SignalFacts {
        const path = nodes.get(mac)?.ancestors ?? []
        const global = gateway?.mac === mac
        return { mac, ancestors: path, global, ...(affected && {
          devices: [...nodes.values()].filter(node => (node.device.mac === mac || node.ancestors.includes(mac))
            && !power.device(node.device.mac)).map(({ device }) => {
            const seen = clients.get(device.mac)
            const known = device.clients ?? db.select({ clients: deviceSamples.clients }).from(deviceSamples)
              .where(and(eq(deviceSamples.mac, device.mac), isNotNull(deviceSamples.clients), lte(deviceSamples.ts, at)))
              .orderBy(desc(deviceSamples.ts)).get()?.clients ?? 0
            return { mac: device.mac, clients: Math.max(known, seen?.count ?? 0), people: [...seen?.people ?? []],
              groups: seen?.groups.size ? [...seen.groups] : device.type === 'ap' ? ['clients:' + device.mac] : [] }
          }),
        }) }
      },
    }
  }

  function publish(incident: IncidentT) {
    const { id, status, severity } = incident
    bus.emit({ type: 'incident', data: { id, status, severity } })
  }

  function notify(incident: IncidentT, event: 'incident_opened' | 'incident_resolved') {
    const { id, titleKey, titleParams, severity, openedAt, resolvedAt } = incident
    emit({ type: 'notification', event, incidentId: id, titleKey, titleParams, severity,
      ...(resolvedAt !== null && { duration: (resolvedAt - openedAt) / 1000 }) })
  }

  function lifecycle(incident: IncidentT, action: 'opened' | 'escalated' | 'resolved') {
    const { id, titleKey, titleParams, severity } = incident
    audit.record({ actor: system, category: 'system', action: 'incident.' + action,
      severity: action === 'resolved' ? 'success' : severity === 'critical' ? 'error' : 'warning',
      target: { type: 'incident', id, label: titleParams.name ?? id },
      messageKey: 'audit.incident.' + action, messageParams: { ...titleParams,
        ...(incident.resolvedAt !== null && { duration: String((incident.resolvedAt - incident.openedAt) / 1000) }) } })

    if (action === 'opened') emit({ type: 'incident.opened', id, severity, titleKey, titleParams })
    const { notifyMinSeverity } = settings.get().incidents
    if (notifyMinSeverity === 'off' || notifyMinSeverity === 'critical' && severity !== 'critical') return
    notify(incident, action === 'resolved' ? 'incident_resolved' : 'incident_opened')
  }

  function settle(run: Runtime, at: number) {
    const store = createIncidentStore(db, run.scope)
    for (const incident of store.settle(settings.get().incidents.quietMinutes, at)) {
      publish(incident)
      lifecycle(incident, 'resolved')
    }
  }

  function arm(run: Runtime) {
    clearTimeout(quietTimer)
    const at = now()
    const { quietMinutes } = settings.get().incidents
    const due = createIncidentStore(db, run.scope).open().map(({ signals }) => {
      const { pending, lastRecovery, lastFailure } = recoveryState(signals)
      return pending.size || lastRecovery === null ? Infinity : Math.max(lastRecovery, lastFailure) + quietMinutes * MINUTE
    })
    const next = Math.min(...due)
    if (Number.isFinite(next)) {
      quietTimer = setTimeout(() => {
        const active = refreshScope()
        if (active) { settle(active, now()); arm(active) }
      }, Math.max(1, next - at))
      quietTimer.unref()
    }
  }

  function record(run: Runtime, signal: Signal, baseline = 0) {
    const store = createIncidentStore(db, run.scope)
    settle(run, signal.ts)
    for (const { incident, event } of store.persist(signal, baseline, settings.get().incidents.windowMinutes)) {
      publish(incident)
      if (event !== 'changed') lifecycle(incident, event)
    }
    arm(run)
  }

  function pending(run: Runtime, key: string) {
    return createIncidentStore(db, run.scope).open().some(entry => recoveryState(entry.signals).pending.has(key))
  }

  function expireLosses(at: number) {
    for (const [mac, loss] of departures) if (loss.at < at - clientWindow) departures.delete(mac)
  }

  function burst(run: Runtime, at: number) {
    expireLosses(at)
    const store = createIncidentStore(db, run.scope)
    const activeMass = new Map<string, Signal>()
    for (const { signals } of store.open()) {
      const { pending } = recoveryState(signals)
      for (const signal of signals) {
        if (signal.kind === 'mass_disconnect' && signal.facts.mac && pending.has(massKey(signal.facts.mac))) {
          activeMass.set(signal.facts.mac, signal)
        }
      }
    }
    if (!departures.size && !activeMass.size) return

    const topology = context(run, at)
    const groups = new Map<string, string[]>()
    for (const { station } of departures.values()) {
      const mac = deviceOf(station)
      if (!mac || topology.power.client(station)) continue
      const group = groups.get(mac) ?? []
      group.push(station.mac)
      groups.set(mac, group)
    }
    for (const [mac, signal] of activeMass) {
      const lost = new Set(signal.facts.lostClients)
      if (at <= signal.ts + clientWindow) {
        for (const client of groups.get(mac) ?? []) lost.add(client)
      }
      if (lost.size !== signal.facts.lostClients?.length) {
        store.extendMass(signal, [...lost])
      }
      const returned = [...lost].filter(client => online.has(client)).length
      if (returned * 10 >= lost.size * 7) {
        record(run, makeSignal('clients_returned', at, topology.ref(mac), { mac, recovers: [massKey(mac)] }, '', String(returned)))
        for (const client of lost) departures.delete(client)
      }
      groups.delete(mac)
    }

    const { massDisconnectMin, massDisconnectPct } = settings.get().incidents
    for (const [mac, lost] of groups) {
      if (lost.length < massDisconnectMin || !topology.hasDevice(mac)) continue
      const remaining = [...online.values()].filter(station => deviceOf(station) === mac
        && !topology.hasDevice(station.mac) && !topology.power.client(station)).length
      const total = remaining + lost.length
      if (100 * lost.length < massDisconnectPct * total) continue
      record(run, makeSignal('mass_disconnect', at, topology.ref(mac), {
        ...topology.facts(mac, true), failure: massKey(mac), lostClients: lost,
      }, '', String(lost.length)), topology.baseline)
    }
  }

  function clientEvent(event: Extract<ControllerEvent, { data: unknown }>, run: Runtime, at: number) {
    if (event.type !== 'client.disconnected' && event.type !== 'client.connected' && event.type !== 'client.roam') return
    const old = online.get(event.mac)
    if (event.type === 'client.disconnected') {
      if (!old) return
      online.delete(event.mac)
      const station = { ...old, ...event.data, mac: event.mac }
      const power = planned(run, at)
      if (deviceOf(station) && !power.adopted(station.mac) && !power.client(station)) departures.set(event.mac, { station, at })
    } else {
      online.set(event.mac, { ...departures.get(event.mac)?.station, ...old, ...event.data, mac: event.mac })
      departures.delete(event.mac)
    }
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      if (refreshScope() === run) burst(run, now())
    })
  }

  function onAudit(entry: AuditEventT) {
    const run = refreshScope()
    if (!run || !configCategories.has(entry.category) || entry.dryRun || entry.severity === 'error') return
    if (entry.actor.type !== 'external' && entry.actor.type !== 'unifire'
      && entry.messageKey !== 'audit.unifi.writeApplied' && entry.messageKey !== 'audit.snapshot.restoreApplied') return
    record(run, makeSignal('config_change', entry.ts, { type: 'audit', id: entry.id,
      label: entry.target?.label ?? entry.actor.name ?? '' }, {}, '', '', String(Math.max(0, Math.floor((now() - entry.ts) / MINUTE)))))
  }

  function observeWan(run: Runtime, event: Extract<ControllerEvent, { type: 'wan.observed' }>) {
    const allDown = event.readings.length > 0 && event.readings.every(reading => reading.up === false)
    const known = db.select().from(incidentWanState).where(eq(incidentWanState.scope, run.scope)).all()
    const byId = new Map(known.map(row => [row.egressId, row.up]))
    for (const { id, name, up } of event.readings) {
      if (up === null || byId.get(id) === up) continue
      const key = 'wan/' + id
      if (!up || byId.get(id) === false) {
        const facts = up ? { recovers: [key] } : { global: true, failure: key, egressId: id, critical: allDown }
        record(run, makeSignal(up ? 'wan_up' : 'wan_down', event.at, { type: 'egress', id, label: name }, facts))
      } else {
        db.insert(incidentWanState).values({ scope: run.scope, egressId: id, up }).onConflictDoNothing().run()
      }
    }
  }

  function onEvent(event: ControllerEvent) {
    const run = refreshScope()
    if (!run) return
    const at = 'at' in event && typeof event.at === 'number' ? event.at : now()
    switch (event.type) {
      case 'client.connected':
      case 'client.disconnected':
      case 'client.roam':
        return clientEvent(event, run, at)
      case 'client.updated': {
        const old = event.mac && online.get(event.mac)
        if (old && event.mac) online.set(event.mac, { ...old, ...event.data, mac: event.mac })
        return
      }
      case 'cache.clientsPolled': {
        // Polls also seed the initial baseline and refresh silent attachment changes.
        const clients = run.cache.snapshot().activeClients
        online.clear()
        for (const station of clients) online.set(station.mac, station)
        return burst(run, at)
      }
      case 'wan.observed':
        return observeWan(run, event)
      case 'egress.healthChanged': {
        const health = db.select().from(egressHealth).where(eq(egressHealth.egressId, event.egressId)).get()?.value
        if (health?.status === 'healthy' || health?.status === 'degraded') {
          if (pending(run, 'egress/' + event.egressId)) onEvent({ type: 'egress.up', egressId: event.egressId, at })
        }
        return
      }
      case 'egress.down':
      case 'egress.up': {
        const rows = exits(run)
        const row = rows.find(row => row.id === event.egressId)
        if (!row) return
        const key = 'egress/' + row.id
        const down = event.type === 'egress.down'
        const alreadyDown = pending(run, key)
        if (alreadyDown === down) return
        const allDown = down && rows.every(exit => db.select().from(egressHealth)
          .where(eq(egressHealth.egressId, exit.id)).get()?.value.status === 'down')
        record(run, makeSignal(down ? 'egress_down' : 'egress_up', at, { type: 'egress', id: row.id, label: row.name },
          down ? { global: true, failure: key, egressId: row.id, critical: allDown } : { recovers: [key] }))
        return
      }
      case 'infra.offline':
      case 'infra.online':
      case 'infra.rebooted': {
        if (event.type === 'infra.offline' && event.planned || event.type === 'infra.rebooted' && !event.unexpected) return
        const { mac } = event
        const topology = context(run, at)
        if (event.type !== 'infra.online' && topology.power.device(mac)) return
        const ref = topology.ref(mac)
        if (event.type === 'infra.online') {
          record(run, makeSignal('device_online', at, ref, { mac, recovers: [deviceKey(mac), rebootKey(mac)] }))
        } else if (event.type === 'infra.offline') {
          const facts = topology.facts(mac, true)
          record(run, makeSignal('device_offline', at, ref, { ...facts, failure: deviceKey(mac), critical: facts.global }), topology.baseline)
        } else {
          record(run, makeSignal('device_rebooted', at, ref, {
            ...topology.facts(mac, true), failure: rebootKey(mac),
          }, '', '', '0'), topology.baseline)
          // The sampler detects an uptime reset on the first online reading.
          record(run, makeSignal('device_online', at, ref, { mac, recovers: [rebootKey(mac)] }))
        }
        return
      }
      case 'port.issue':
      case 'port.link':
      case 'port.stable': {
        const { switchMac, portIdx } = event
        const topology = context(run, at)
        const mac = event.type === 'port.link' ? event.downstreamMac : switchMac
        const recovering = event.type === 'port.stable' || event.type === 'port.link' && event.up
        if (!recovering && (topology.power.device(mac) || topology.power.port(switchMac, portIdx))) return
        const ref = { type: 'port' as const, id: switchMac + ':' + portIdx, label: topology.ref(mac).label }
        let signal: Signal
        if (event.type === 'port.link') {
          const key = linkKey(switchMac, event.peerMac)
          if (pending(run, key) !== event.up) return
          const facts = event.up ? { recovers: [key] } : { ...topology.facts(mac, true), failure: key }
          signal = makeSignal(event.up ? 'uplink_up' : 'uplink_down', at, ref, facts, String(portIdx))
        } else if (event.type === 'port.stable') {
          if (!pending(run, portKey(switchMac, portIdx))) return
          signal = makeSignal('port_issue', at, ref, { recovers: [portKey(switchMac, portIdx)] }, String(portIdx))
        } else {
          const flaps = event.kind === 'flapping'
          signal = makeSignal('port_issue', at, ref, { ...topology.facts(mac, flaps),
            ...(flaps && { failure: portKey(switchMac, portIdx) }) }, String(portIdx))
        }
        record(run, signal, topology.baseline)
        return
      }
      case 'routing.settings':
      case 'controller.reconnected':
        settle(run, at)
        arm(run)
    }
  }

  function start(hasLease: () => boolean) {
    leased = hasLease
    const unsubscribe = bus.subscribe(event => { if (event.type === 'audit') onAudit(event.data) })
    service.engine.on('event', onEvent)
    const tick = () => {
      const run = refreshScope()
      if (!run) return
      const at = now()
      if (nextPrune <= at) {
        createIncidentStore(db, run.scope).prune(at)
        nextPrune = at + DAY
      }
      settle(run, at)
      arm(run)
    }
    const interval = setInterval(tick, MINUTE)
    interval.unref()
    tick()
    return () => {
      leased = () => false
      service.engine.off('event', onEvent)
      unsubscribe()
      clearTimeout(quietTimer)
      clearInterval(interval)
    }
  }

  return { start }
}
