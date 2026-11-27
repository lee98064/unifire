import { randomUUID } from 'node:crypto'
import { and, eq, gte, lt } from 'drizzle-orm'
import type { PortViewT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import type { Db } from '../../db'
import { clients, personDevices, poeApplied, poeSchedules, portDeltas, portEvents, portPeers, portState, type PortCounters } from '../../db/schema'
import { createAuditService } from '../../services/audit'
import { systemContext, type ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { deviceName, deviceState, finiteNumber } from '../../unifi/device-shape'
import type { WireDevice, WireDoc, WireStation } from '../../unifi/endpoints/schemas'
import type { ControllerEvent } from '../../unifi/ws'
import { liveBus } from '../../utils/bus'
import { DAY, HOUR } from '../access-time'
import { createDeviceGraph, createPoeSafety } from './poe-safety'
import { archivePorts, customPortName, PORT_BUCKET, portKey, portSpeedLabel, recentDeltas, samplePort, type PortKey } from './port-history'
import { readPorts } from './ports'

const fields = ['rx_errors', 'tx_errors', 'rx_dropped', 'tx_dropped', 'rx_packets', 'tx_packets', 'link_down_count'] as const
type Saved = typeof portState.$inferSelect
type Reading = ReturnType<typeof readPorts>[number]
type Kind = typeof portEvents.$inferSelect.kind
const severity = { downgrade: 'warning', recovered: 'info', errors: 'warning', flapping: 'error', new_device: 'warning', peer_changed: 'info' } as const

export function portCounters(raw: WireDoc): PortCounters {
  const read = (field: typeof fields[number]) => {
    const value = finiteNumber(raw[field])
    return value !== null && value >= 0 ? value : null
  }
  return { rx_errors: read('rx_errors'), tx_errors: read('tx_errors'), rx_dropped: read('rx_dropped'), tx_dropped: read('tx_dropped'),
    rx_packets: read('rx_packets'), tx_packets: read('tx_packets'), link_down_count: read('link_down_count') }
}

export function counterDeltas(before: Saved | undefined, now: PortCounters, up: boolean) {
  const delta = (key: keyof PortCounters) => {
    const previous = before?.counters[key]
    const current = now[key]
    return previous != null && current !== null ? current - previous : null
  }
  const reset = fields.some(field => (delta(field) ?? 0) < 0)
  const pair = (rx: keyof PortCounters, tx: keyof PortCounters) => {
    const values = [delta(rx), delta(tx)]
    if (values.every(value => value === null)) return null
    return reset ? 0 : (values[0] ?? 0) + (values[1] ?? 0)
  }
  const native = delta('link_down_count')
  return {
    errors: pair('rx_errors', 'tx_errors'), packets: pair('rx_packets', 'tx_packets'), drops: pair('rx_dropped', 'tx_dropped'),
    flaps: now.link_down_count === null ? Number(before?.up === true && !up && !reset) : Math.max(0, native ?? 0),
  }
}

export function speedBaseline(before: Saved | undefined, port: PortViewT, at: number, minPolls: number, ignored: boolean) {
  const peerMac = port.peer?.mac ?? (!port.up ? before?.peerMac ?? null : null)
  const peerKind = port.peer?.mac ? port.peer.kind : peerMac ? before?.peerKind ?? null : null
  const samePeer = peerMac !== null && peerMac === before?.peerMac
  const speeds = samePeer ? before.speeds.filter(sample => sample.at > at - 30 * DAY) : []
  const speed = port.speedMbps
  const negotiating = peerMac !== null && port.up && speed !== null && speed > 0
  if (negotiating) {
    while (speeds.length && speeds.at(-1)!.speed <= speed) speeds.pop()
    speeds.push({ at, speed })
  }
  const baselineSpeed = speeds[0]?.speed ?? null
  const below = !ignored && samePeer && negotiating && baselineSpeed !== null && speed < baselineSpeed
    ? (before.below + 1) : 0
  const wasDowngraded = !ignored && samePeer && before.downgraded
  const recovered = wasDowngraded && negotiating && baselineSpeed !== null && speed >= baselineSpeed
  const downgraded = !ignored && (below >= minPolls || wasDowngraded && !recovered && baselineSpeed !== null)
  return { peerMac, peerKind, speeds, baselineSpeed, below, downgraded,
    event: recovered ? 'recovered' as const : downgraded && !wasDowngraded ? 'downgrade' as const : null }
}

export function createPortHealth(db: Db, service: ControllerService, bus = liveBus) {
  const settings = createSettingsService(db)
  const audit = createAuditService(db, bus)
  let archiveHour = 0
  function sample(devices: readonly WireDevice[], stations: readonly WireStation[], scope: string, at: number,
    observeEnergy: (tx: Pick<Db, 'insert' | 'select'>, key: PortKey, port: PortViewT, at: number) => void) {
    const config = settings.get().infra
    const ignored = new Set(config.ignoredPorts.map(port => port.switchMac + '/' + port.portIdx))
    const graph = createDeviceGraph(devices)
    const { selfMac, selfIp } = service.status()
    const safety = createPoeSafety(graph, stations, { mac: selfMac, ip: selfIp })
    const hour = Math.floor(at / HOUR) * HOUR
    const linkEvents: ControllerEvent[] = []
    const emitted: { row: typeof portEvents.$inferInsert, notify: boolean }[] = []
    db.transaction(tx => {
      const approved = new Set(tx.select({ mac: clients.mac }).from(clients).where(eq(clients.approval, 'approved')).all().map(row => row.mac))
      const owners = new Map(tx.select().from(personDevices).all().map(row => [row.mac, row.personId]))
      for (const device of graph.byMac.values()) {
        if (deviceState(device) === 'offline' || deviceState(device) === 'restarting') continue
        const firstSeen = new Map(tx.select().from(portPeers).where(and(eq(portPeers.scope, scope), eq(portPeers.switchMac, device.mac)))
          .all().map(row => [row.portIdx + '/' + row.mac, row.firstSeen]))
        for (const reading of readPorts(device, graph, stations, safety, owners, firstSeen)) {
          const { view } = reading
          const key = { scope, switchMac: device.mac, portIdx: view.idx }
          const skip = ignored.has(device.mac + '/' + view.idx)
          const previous = tx.select().from(portState).where(portKey(portState, key)).get()
          if (previous && previous.at >= at) continue
          const counters = portCounters(reading.raw)
          const delta = counterDeltas(previous, counters, view.up)
          tx.insert(portDeltas).values({ ...key, ts: at, errors: delta.errors, packets: delta.packets, flaps: delta.flaps }).run()
          const recent = recentDeltas(tx, key, at)
          const baseline = speedBaseline(previous, view, at, config.downgradeMinPolls, skip)
          const firstSeen = previous?.firstSeen ?? at
          const previousDrop = previous?.lastDrop ?? null
          const lastDrop = delta.flaps > 0 ? at : previousDrop
          const rearmed = previousDrop !== null && at - previousDrop >= HOUR && (view.up || delta.flaps > 0)
          let flapAt = rearmed ? null : previous?.flapAt ?? null
          if (previous?.flapAt != null && rearmed) {
            // End the previous burst before publishing any new flapping event from this poll.
            linkEvents.push({ type: 'port.stable', switchMac: device.mac, portIdx: view.idx,
              at: delta.flaps > 0 ? previousDrop + HOUR : at })
          }
          const peer = view.peer?.kind === 'device' ? view.peer.mac : previous?.peerKind === 'device' ? previous.peerMac : null
          if (!skip && peer && previous && previous.up !== view.up) {
            linkEvents.push({ type: 'port.link', switchMac: device.mac, portIdx: view.idx,
              peerMac: peer, downstreamMac: view.isUplink ? device.mac : peer, at, up: view.up })
          }
          let errorAt = previous?.errorAt ?? null
          const addEvent = (kind: Kind) => {
            const switchName = deviceName(device)
            const peer = view.peer
            const row = {
              ...key, id: randomUUID(), ts: at, switchName, portName: view.name, kind, severity: severity[kind],
              messageKey: `port.event.${kind}`,
              messageParams: { switch: switchName, port: String(view.idx), portName: customPortName(view.name),
                from: portSpeedLabel(previous?.baselineSpeed), to: portSpeedLabel(view.speedMbps), peer: peer?.name ?? peer?.mac ?? '',
                rate: recent.rate?.toFixed(2) ?? '', flaps: String(recent.flaps) },
              data: { fromMbps: previous?.baselineSpeed ?? null, toMbps: view.speedMbps, peerMac: peer?.mac ?? null,
                errorRatePct: recent.rate, flaps: recent.flaps },
            }
            const sent = tx.select({ id: portEvents.id }).from(portEvents).where(and(portKey(portEvents, key),
              eq(portEvents.kind, kind), gte(portEvents.ts, at - 6 * HOUR + 1))).limit(1).get()
            tx.insert(portEvents).values(row).run()
            emitted.push({ row, notify: !sent })
          }
          if (baseline.event) addEvent(baseline.event)
          if (!skip && recent.errors >= 50 && (recent.rate ?? 0) >= config.errorRatePct
            && (errorAt === null || at - errorAt >= 6 * HOUR)) {
            errorAt = at
            addEvent('errors')
          }
          if (!skip && recent.flaps >= config.flapsPerHour && flapAt === null) {
            flapAt = at
            addEvent('flapping')
          }
          learnPeers(reading)
          function learnPeers({ peers, lastMac, lastCurrent, lastSeen, downstream }: Reading) {
            for (const peer of peers) {
              const historical = peer.mac === lastMac && peer.mac !== lastCurrent && peer.mac !== view.peer?.mac
              const seen = historical && lastSeen !== null ? Math.max(0, Math.min(at, lastSeen * 1000)) : at
              const saved = tx.select().from(portPeers).where(and(portKey(portPeers, key), eq(portPeers.mac, peer.mac))).get()
              if (!saved && !historical && !skip && at - firstSeen >= DAY && view.up && peer.mac === view.peer?.mac
                && !view.isUplink && !downstream && view.peer.count <= 1) {
                addEvent(approved.has(peer.mac) || graph.byMac.has(peer.mac) ? 'peer_changed' : 'new_device')
              }
              const speed = view.up && view.peer?.mac === peer.mac && (view.speedMbps ?? 0) > 0 ? view.speedMbps : null
              const maxSpeed = speed === null ? saved?.maxSpeed ?? null : Math.max(speed, saved?.maxSpeed ?? 0)
              const values = { lastSeen: Math.max(saved?.lastSeen ?? 0, seen), name: peer.name ?? saved?.name ?? null, maxSpeed }
              tx.insert(portPeers).values({ ...key, mac: peer.mac, firstSeen: seen, ...values }).onConflictDoUpdate({
                target: [portPeers.scope, portPeers.switchMac, portPeers.portIdx, portPeers.mac], set: values,
              }).run()
            }
          }
          const { event: _event, ...speed } = baseline
          const state = { ...speed, firstSeen, at, up: view.up, speed: view.speedMbps, duplex: view.fullDuplex, counters, lastDrop, flapAt, errorAt }
          tx.insert(portState).values({ ...key, ...state }).onConflictDoUpdate({
            target: [portState.scope, portState.switchMac, portState.portIdx], set: state,
          }).run()
          const watts = view.poe?.powerW ?? null
          const onW = view.poe?.mode && view.poe.mode !== 'off' ? watts : null
          samplePort(tx, { ...key, ts: Math.floor(at / PORT_BUCKET) * PORT_BUCKET, observed: 1, up: Number(view.up),
            speed: view.speedMbps, rx: view.rxBps, rxCount: Number(view.rxBps !== null), tx: view.txBps, txCount: Number(view.txBps !== null),
            errors: delta.errors, drops: delta.drops, poe: watts, poeCount: Number(watts !== null), onW, onCount: Number(onW !== null) })
          observeEnergy(tx, key, view, at)
        }
      }
      tx.delete(portDeltas).where(lt(portDeltas.ts, at - HOUR)).run()
      if (hour !== archiveHour) archivePorts(tx, archiveHour, at, config)
    })
    archiveHour = hour
    for (const event of linkEvents) service.engine.emit('event', event)
    for (const { row, notify } of emitted) {
      const { switchMac, portIdx, kind, id } = row
      audit.record({ actor: systemContext.actor, category: 'device', action: `port.${kind}`, severity: row.severity,
        target: { type: 'port', id: `${switchMac}/${portIdx}`, label: row.portName ?? String(portIdx) },
        messageKey: row.messageKey, messageParams: row.messageParams }, at)
      bus.emit({ type: 'port.event', data: { id, switchMac, portIdx, kind } })
      service.engine.emit('event', { type: 'port.issue', switchMac, portIdx, kind, eventId: id, at })
      if (notify) service.engine.emit('event', { type: 'notification', event: 'port_issue', ...row.messageParams,
        switchMac, portIdx, kind, eventId: id })
    }
  }
  return { sample }
}

export function portIssues(db: Db, scope: string, config: SettingsT['infra'], at: number) {
  const key = (mac: string, idx: number) => mac + '/' + idx
  const ignored = new Set(config.ignoredPorts.map(port => key(port.switchMac, port.portIdx)))
  const active = new Map<string, PortViewT['issues']>()
  function add(mac: string, idx: number, kind: PortViewT['issues'][number]) {
    const id = key(mac, idx)
    if (ignored.has(id)) return
    const values = active.get(id) ?? []
    if (!values.includes(kind)) values.push(kind)
    active.set(id, values)
  }
  for (const row of db.select().from(portState).where(and(eq(portState.scope, scope), eq(portState.downgraded, true))).all()) {
    if (row.speeds[0] && row.speeds[0].at > at - 30 * DAY) add(row.switchMac, row.portIdx, 'downgrade')
  }
  for (const row of db.select().from(portEvents).where(and(eq(portEvents.scope, scope), gte(portEvents.ts, at - DAY))).all()) {
    const age = at - row.ts
    if (row.kind === 'flapping' && age < HOUR || row.kind === 'errors' && !row.acknowledged && age < 6 * HOUR
      || (row.kind === 'new_device' || row.kind === 'peer_changed') && !row.acknowledged && age < DAY) {
      add(row.switchMac, row.portIdx, row.kind)
    }
  }
  return active
}

export function enrichPort(db: Db, key: PortKey, view: PortViewT, at: number, issues: PortViewT['issues']): PortViewT {
  const state = db.select().from(portState).where(portKey(portState, key)).get()
  const recent = recentDeltas(db, key, at)
  const schedule = view.poe && db.select({ id: poeSchedules.id }).from(poeSchedules).where(portKey(poeSchedules, key)).get()
  const hold = view.poe && db.select().from(poeApplied).where(portKey(poeApplied, key)).get()
  return { ...view, issues, baselineSpeedMbps: state?.speeds.find(sample => sample.at > at - 30 * DAY)?.speed ?? null,
    errorRatePct: recent.rate, flaps1h: recent.flaps, poe: view.poe && {
      ...view.poe, scheduleId: schedule ? schedule.id : null, heldOffByUnifire: !!hold && view.poe.mode === 'off',
    } }
}
