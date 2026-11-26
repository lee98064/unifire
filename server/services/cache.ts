import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { clients, egresses } from '../db/schema'
import type { UnifiEndpoints } from '../unifi/endpoints'
import type { WireDevice, WireStation } from '../unifi/endpoints/schemas'
import type { ControllerEvent, EngineEvents } from '../unifi/ws'
import { liveBus } from '../utils/bus'
import { macVendor } from './oui'

const POLL_MS = {
  networks: 300_000, routes: 30_000, activeClients: 15_000, knownClients: 60_000,
  devices: 60_000, wlans: 300_000,
}
type Resource = keyof typeof POLL_MS
const resources = Object.keys(POLL_MS) as Resource[]
type Snapshot = { [K in Resource]: Awaited<ReturnType<UnifiEndpoints[K]>> }
type Throughput = { ts: number, rxBps: number, txBps: number }
type PollResult = { resource: Resource, at: number, error: unknown | null }

export const EGRESS_COLORS = ['#006FFF', '#38A46B', '#DA8C18', '#8E59FF', '#3294AB', '#C4578A', '#6375D4',
  '#CB6737', '#7F931F', '#167E78', '#9D65A8', '#DC555E']

function wanOrder(group?: string | null) {
  if (group === 'WAN' || group === 'WAN1') return 1
  return Number(group?.match(/^WAN(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

export function syncEgresses(db: Db, site: string, networks: Snapshot['networks']) {
  const reads = networks.filter(network => network.purpose === 'wan' || network.purpose === 'vpn-client')
    .sort((a, b) => wanOrder(a.wan_networkgroup) - wanOrder(b.wan_networkgroup) || a._id.localeCompare(b._id, 'en', { numeric: true }))
  db.transaction(tx => {
    const persisted = tx.select().from(egresses).where(eq(egresses.site, site)).all()
    const reserved = new Set(persisted.map(row => row.color.toLowerCase()))
    for (const [index, network] of reads.entries()) {
      const wan = network.purpose === 'wan'
      const kind = wan ? 'wan' : network.vpn_type === 'wireguard-client' ? 'wireguard'
        : network.vpn_type === 'openvpn-client' ? 'openvpn' : 'other'
      const color = EGRESS_COLORS.find(item => !reserved.has(item.toLowerCase())) ?? EGRESS_COLORS[index % EGRESS_COLORS.length]!
      const existing = persisted.find(item => item.id === network._id)
      const fields = { name: network.name, kind, wanGroup: wan ? network.wan_networkgroup ?? null : null, enabled: network.enabled ?? true } as const
      tx.insert(egresses).values({ id: network._id, site, color, ...fields })
        .onConflictDoUpdate({ target: egresses.id, set: { ...fields, site }, setWhere: eq(egresses.site, site) }).run()
      if (!existing) reserved.add(color.toLowerCase())
    }
  })
}

export function wireTime(value?: number | null) {
  if (value == null || value < 0) return null
  return Math.floor(value < 1e12 ? value * 1000 : value)
}

function liveClientFields(station: WireStation | undefined) {
  if (!station) return null
  return [
    station.ip, station.hostname, station.name, station.oui, station.fixed_ip, station.use_fixedip,
    station.network_id, station.network, station.is_wired, station.ap_mac, station.sw_mac,
    station.sw_port, station.essid, station.signal, station.blocked, station['rx_bytes-r'], station['tx_bytes-r'],
  ]
}

function changedClients(before: WireStation[], after: WireStation[]) {
  const old = new Map(before.map(item => [item.mac, liveClientFields(item)]))
  const current = new Map(after.map(item => [item.mac, liveClientFields(item)]))
  return [...new Set([...old.keys(), ...current.keys()])].filter(mac => !isDeepStrictEqual(old.get(mac), current.get(mac)))
}

export function isGateway(device: WireDevice) {
  return device.type === 'udm' || device.type === 'ugw' || device.type === 'uxg'
}

export function rate(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 8 : null
}

export function createSyncCache(api: UnifiEndpoints, options: {
  db: Db
  site: string
  engine: EngineEvents
  onPoll: (result: PollResult) => void
  active: () => boolean
  bus?: typeof liveBus
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const bus = options.bus ?? liveBus
  const snapshot: Snapshot = { networks: [], routes: [], activeClients: [], knownClients: [], devices: [], wlans: [] }
  const inFlight = new Map<Resource, Promise<void>>()
  const pollTimers = new Set<ReturnType<typeof setInterval>>()
  const wsRefreshes = new Set<Resource>()
  let wsTimer: ReturnType<typeof setTimeout> | undefined
  let gateway: WireDevice | null = null
  let stopped = false
  let started = false
  const throughput: Throughput[] = []

  function syncClients(rows: WireStation[], online: boolean, at: number) {
    options.db.transaction(tx => {
      const previous = new Map(tx.select().from(clients).all().map(client => [client.mac, client]))
      for (const station of rows) {
        const old = previous.get(station.mac)
        const firstSeen = old?.firstSeen ?? wireTime(station.first_seen) ?? at
        const lastSeen = Math.max(old?.lastSeen ?? 0, wireTime(station.last_seen) ?? 0, online ? at : 0) || null
        const { vendor, randomizedMac } = macVendor(station.mac, station.oui)
        const fields = { hostname: station.hostname ?? old?.hostname ?? null, vendor: vendor ?? old?.vendor ?? null,
          randomizedMac, firstSeen, lastSeen }
        tx.insert(clients).values({ mac: station.mac, detectedAt: at, ...fields })
          .onConflictDoUpdate({ target: clients.mac, set: fields }).run()
      }
    })
  }

  async function refreshGateway(preferred: WireDevice | undefined, at: number) {
    let current = preferred
    if (!current || rate(current['rx_bytes-r']) === null || rate(current['tx_bytes-r']) === null) {
      const extra = await api.gateway().then(devices => devices[0]).catch(() => undefined)
      if (extra) current = { ...current, ...extra }
    }
    if (!current || stopped || !options.active()) return
    gateway = current
    const rxBps = rate(current['rx_bytes-r'])
    const txBps = rate(current['tx_bytes-r'])
    const ts = Math.floor(at / 60_000) * 60_000
    while (throughput[0] && throughput[0].ts < ts - 59 * 60_000) throughput.shift()
    if (rxBps === null || txBps === null) return
    if (throughput.at(-1)?.ts === ts) throughput.pop()
    throughput.push({ ts, rxBps, txBps })
  }

  async function update<K extends Resource>(resource: K, load: () => Promise<Snapshot[K]>) {
    try {
      const before = snapshot[resource]
      const next = await load()
      if (stopped || !options.active()) return
      const at = now()
      if (resource === 'networks') syncEgresses(options.db, options.site, next as Snapshot['networks'])
      if (resource === 'activeClients' || resource === 'knownClients') {
        syncClients(next as WireStation[], resource === 'activeClients', at)
      }
      snapshot[resource] = next
      if (!isDeepStrictEqual(before, next)) {
        options.engine.emit('event', { type: 'cache.changed', resource })
        if (resource === 'activeClients' || resource === 'knownClients') {
          const macs = changedClients(before as WireStation[], next as WireStation[])
          if (macs.length) bus.emit({ type: 'client.changed', data: { macs } })
        }
      }
      options.onPoll({ resource, at, error: null })
      if (resource === 'devices') await refreshGateway((next as WireDevice[]).find(isGateway), at)
    } catch (error) {
      if (!stopped && options.active()) options.onPoll({ resource, at: now(), error })
      throw error
    }
  }

  function load(resource: Resource) {
    switch (resource) {
      case 'networks': return update(resource, api.networks)
      case 'routes': return update(resource, api.routes)
      case 'activeClients': return update(resource, api.activeClients)
      case 'knownClients': return update(resource, api.knownClients)
      case 'devices': return update(resource, api.devices)
      case 'wlans': return update(resource, api.wlans)
    }
  }

  function refresh(resource: Resource) {
    if (stopped || !options.active()) return Promise.resolve()
    const queued = inFlight.get(resource)
    if (queued) return queued
    const work = load(resource).finally(() => inFlight.delete(resource))
    inFlight.set(resource, work)
    return work
  }

  function onEvent(event: ControllerEvent) {
    switch (event.type) {
      case 'client.connected':
      case 'client.disconnected':
      case 'client.roam':
      case 'client.updated': wsRefreshes.add('activeClients'); break
      case 'device.updated': wsRefreshes.add('devices'); break
      case 'user.updated': wsRefreshes.add('knownClients'); break
      case 'controller.reconnected':
        for (const resource of ['activeClients', 'knownClients', 'devices'] as const) wsRefreshes.add(resource)
        break
      case 'controller.event':
        if (/Route|Policy/.test(event.key)) wsRefreshes.add('routes')
        else if (/WLAN|Wlan|SSID/.test(event.key)) wsRefreshes.add('wlans')
        else if (/Network|WAN/.test(event.key)) wsRefreshes.add('networks')
        break
      case 'cache.changed': return
    }
    if (!wsTimer && wsRefreshes.size) {
      wsTimer = setTimeout(() => {
        wsTimer = undefined
        for (const resource of wsRefreshes) {
          // If a poll started before the event, follow it with a fresh read.
          void Promise.resolve(inFlight.get(resource)).catch(() => {}).then(() => refresh(resource)).catch(() => {})
        }
        wsRefreshes.clear()
      }, 250)
      wsTimer.unref()
    }
  }

  return {
    snapshot: () => snapshot as Readonly<Snapshot>,
    gateway: () => gateway,
    throughput: () => throughput.filter(point => point.ts >= Math.floor(now() / 60_000) * 60_000 - 59 * 60_000),
    refresh,
    async sync() {
      return Promise.allSettled(resources.map(refresh))
    },
    start() {
      if (started || stopped) return
      started = true
      options.engine.on('event', onEvent)
      for (const resource of resources) {
        const timer = setInterval(() => { void refresh(resource).catch(() => {}) }, POLL_MS[resource])
        timer.unref()
        pollTimers.add(timer)
      }
    },
    stop() {
      stopped = true
      options.engine.off('event', onEvent)
      clearTimeout(wsTimer)
      for (const timer of pollTimers) clearInterval(timer)
    },
  }
}

export type SyncCache = ReturnType<typeof createSyncCache>
