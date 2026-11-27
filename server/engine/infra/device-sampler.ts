import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import type { DeviceTransitionT } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { deviceSamples, deviceTransitions, firmwareHistory, infraDevices } from '../../db/schema'
import { wireTime } from '../../services/client-sync'
import { createSettingsService } from '../../services/settings'
import { normalizeDevice } from '../../unifi/device-shape'
import type { WireDevice } from '../../unifi/endpoints/schemas'
import type { InfraEvent } from '../../unifi/ws'
import { HOUR, MINUTE } from '../access-time'
import { archiveDeviceSamples, availabilityByDevice } from './device-history'

import { createDeviceGraph, deviceAncestors, lastKnownParents } from './poe-safety'
import { plannedPoePorts, plannedPower } from './poe-state'

type Device = ReturnType<typeof normalizeDevice>
type Saved = typeof infraDevices.$inferSelect
type RebootReason = Extract<DeviceTransitionT['reason'], 'unifire_restart' | 'upgrade' | 'unexpected_reboot'>

export function classifyReboot(previous: Saved, current: Device, at: number, explains: (mac: string, at: number) => boolean): RebootReason | null {
  const uptime = current.uptimeSec
  if (current.state !== 'online' || uptime === null) return null
  const reset = previous.lastUptime !== null && previous.uptimeAt !== null
    && previous.lastUptime - uptime > Math.max(0, (at - previous.uptimeAt) / 1000) + 5
  const bootedWhileOffline = previous.offlineSince !== null && uptime < (at - previous.offlineSince) / 1000
  if (!reset && !bootedWhileOffline) return null
  if (explains(current.mac, at)) return 'unifire_restart'
  if (previous.upgrading || current.firmware !== null && previous.firmware !== null && current.firmware !== previous.firmware) return 'upgrade'
  return 'unexpected_reboot'
}

export function createDeviceSampler(db: Db, options: {
  emit: (event: InfraEvent) => void
  changed: (macs: string[]) => void
}) {
  const settings = createSettingsService(db)
  let missing = new Map<string, number>()
  let hot = new Set<string>()
  let visible = new Map<string, unknown>()
  let currentScope: string | undefined
  let archiveHour: number | undefined
  let availability = new Map<string, number | null>()

  function sample(devices: readonly WireDevice[], site: string, scope: string, at: number,
    explains: (mac: string, at: number) => boolean = () => false) {
    const changed = new Set<string>()
    if (currentScope !== scope) {
      for (const mac of visible.keys()) changed.add(mac)
      missing.clear()
      hot.clear()
      visible.clear()
      availability.clear()
      currentScope = scope
    }
    const config = settings.get().infra
    const events: InfraEvent[] = []
    const outages: { depth: number, event: InfraEvent }[] = []
    const readings = new Map(devices.filter(device => device.adopted !== false).map(device => [device.mac, device]))
    const graph = createDeviceGraph(devices)
    const ports = plannedPoePorts(db, scope, at, graph)
    const nextVisible = new Map(visible)
    const hour = Math.floor(at / HOUR) * HOUR
    const ts = Math.floor(at / MINUTE) * MINUTE
    const nextMissing = new Map(missing)
    const nextHot = new Set(hot)

    db.transaction(tx => {
      const stored = new Map(tx.select().from(infraDevices).where(eq(infraDevices.scope, scope)).all().map(row => [row.mac, row]))
      const parents = lastKnownParents(graph.parent, stored.values())
      for (const mac of new Set([...stored.keys(), ...readings.keys()])) {
        const previous = stored.get(mac)
        const reading = readings.get(mac)
        const device = reading && normalizeDevice(reading)
        if (device) nextMissing.delete(mac)
        else {
          const count = (nextMissing.get(mac) ?? 0) + 1
          nextMissing.set(mac, Math.min(2, count))
          if (count < 2) {
            if (nextVisible.delete(mac)) changed.add(mac)
            continue
          }
        }

        const state = device?.state ?? 'offline'
        const from = previous?.lastState ?? null
        const parent = parents.get(mac)
        const uplink = device?.uplink
        const lastUplink = parent && uplink?.mac !== parent.mac
          ? { mac: parent.mac, name: null, type: 'unknown' as const, remotePort: parent.port, localPort: parent.localPort ?? null,
              speedMbps: null, fullDuplex: null, signal: null, rxBps: null, txBps: null }
          : uplink?.mac ? { ...uplink, remotePort: parent?.port ?? uplink.remotePort }
          : previous?.lastUplink ?? null
        const planned = plannedPower(mac, parents, ports) !== undefined
        const offlinePlanned = state === 'offline' && planned
        const unplannedNow = state === 'offline' && previous?.offlinePlanned && !offlinePlanned
        const firstSeen = previous?.firstSeen ?? at
        const lastSeen = device
          ? Math.max(previous?.lastSeen ?? 0, wireTime(reading?.last_seen) ?? (state === 'online' ? at : 0)) || null
          : previous?.lastSeen ?? null
        const offlineSince = state === 'online' ? null
          : unplannedNow ? at : previous?.offlineSince ?? (state === 'offline' ? at : null)
        const downSec = state === 'online' && previous?.offlineSince != null ? (at - previous.offlineSince) / 1000 : null
        const uptime = state === 'online' ? device?.uptimeSec ?? null : null
        const firmware = device?.firmware ?? previous?.firmware ?? null
        const upgradeTo = device ? device.upgradeTo : previous?.upgradeTo ?? null
        const reboot = previous && device ? classifyReboot(previous, device, at,
          (mac, ts) => planned || previous.offlinePlanned || explains(mac, ts)) : null
        const fields = {
          lastSeen, lastState: state, firmware, upgradeTo, offlineSince, offlinePlanned, lastUplink,
          lastUptime: uptime ?? previous?.lastUptime ?? null,
          uptimeAt: uptime !== null ? at : previous?.uptimeAt ?? null,
          upgrading: state === 'upgrading' || state !== 'online' && (previous?.upgrading === true
            || previous?.firmware != null && firmware !== previous.firmware),
        }

        if (device) {
          const conflict = !previous && tx.select({ scope: infraDevices.scope }).from(infraDevices).where(eq(infraDevices.mac, mac)).get()
          if (conflict && conflict.scope !== scope) tx.delete(infraDevices).where(eq(infraDevices.mac, mac)).run()
          const { unifiId, name, model, modelName, type } = device
          const identity = { unifiId, name, model, modelName, type }
          tx.insert(infraDevices).values({ mac, site, scope, firstSeen, ...identity, ...fields })
            .onConflictDoUpdate({ target: infraDevices.mac, set: { ...identity, ...fields } }).run()
        } else tx.update(infraDevices).set(fields).where(eq(infraDevices.mac, mac)).run()

        const telemetry = state === 'offline' ? undefined : device
        const values = { state, planned: offlinePlanned, uptime: telemetry?.uptimeSec ?? null, cpu: telemetry?.cpuPct ?? null,
          mem: telemetry?.memPct ?? null, temp: telemetry?.tempC ?? null, clients: telemetry?.clients ?? null,
          rxBps: telemetry?.rxBps ?? null, txBps: telemetry?.txBps ?? null, poeW: telemetry?.poe?.usedW ?? null }
        tx.insert(deviceSamples).values({ mac, ts, ...values })
          .onConflictDoUpdate({ target: [deviceSamples.mac, deviceSamples.ts], set: values }).run()

        if (state !== from || reboot || offlinePlanned !== (previous?.offlinePlanned ?? false)) {
          const reason = reboot ?? (from === null ? 'adopted' : state === 'offline' ? 'offline'
            : downSec !== null ? 'online' : 'state')
          tx.insert(deviceTransitions).values({ mac, ts: at, from, to: state, reason, downSec, planned: offlinePlanned }).run()
        }
        if (state === 'offline' && (from !== 'offline' || offlinePlanned !== previous?.offlinePlanned)) {
          outages.push({ depth: deviceAncestors(mac, parents).length,
            event: { type: 'infra.offline', mac, ...(offlinePlanned && { planned: true }), at } })
        }
        if (state === 'online' && from !== null && from !== 'online') events.push({ type: 'infra.online', mac, downSec: downSec ?? 0, at })
        if (reboot && !planned && !previous?.offlinePlanned) {
          events.push({ type: 'infra.rebooted', mac, unexpected: reboot === 'unexpected_reboot', at })
        }
        if (previous && firmware !== null && firmware !== previous.firmware) {
          tx.insert(firmwareHistory).values({ mac, ts: at, from: previous?.firmware ?? null, to: firmware }).run()
        }
        if (previous && upgradeTo && upgradeTo !== previous.upgradeTo) events.push({ type: 'infra.firmware', mac, version: upgradeTo })
        if (telemetry?.tempC != null) {
          const tempC = telemetry.tempC
          events.push({ type: 'infra.temperature', mac, tempC })
          if (tempC >= config.tempWarnC && !nextHot.has(mac)) {
            nextHot.add(mac)
            events.push({ type: 'infra.overheat', mac, tempC })
          } else if (tempC <= config.tempWarnC - 3) nextHot.delete(mac)
        }

        const view = { device, lastSeen, state, firmware, upgradeTo, offlinePlanned }
        if (reboot || !isDeepStrictEqual(nextVisible.get(mac), view)) changed.add(mac)
        nextVisible.set(mac, view)
      }

      if (archiveHour !== hour) archiveDeviceSamples(tx, archiveHour ?? 0, at, config)
    })

    archiveHour = hour
    missing = nextMissing
    visible = nextVisible
    hot = nextHot
    const currentAvailability = availabilityByDevice(db, scope, at)
    for (const [mac, value] of currentAvailability) {
      if (value !== (availability.get(mac) ?? null)) changed.add(mac)
    }
    availability = currentAvailability
    if (changed.size) options.changed([...changed])
    // A single poll can discover an entire subtree outage. Start with its upstream device.
    for (const { event } of outages.sort((a, b) => a.depth - b.depth)) options.emit(event)
    for (const event of events) options.emit(event)
  }

  return { sample }
}
