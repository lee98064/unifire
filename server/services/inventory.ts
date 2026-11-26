import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { Client, ClientActionInput, ClientUpdateInput } from '#shared/schemas/access'
import { Wlan } from '#shared/schemas/automation'
import { Id } from '#shared/schemas/common'
import { Egress, EgressUpdateInput } from '#shared/schemas/egress'
import { UnifiRoute } from '#shared/schemas/routes'
import { DashboardSummary } from '#shared/schemas/system'
import type { createRouting } from '../engine'
import { latestPublicIp, readHealth, unknownHealth, wanStatus } from '../engine/probes/health'
import type { Db } from '../db'
import { clients, egresses, people, personDevices } from '../db/schema'
import { Doc, MacAddress, type WireStation } from '../unifi/endpoints/schemas'
import { UnifiError } from '../unifi/errors'
import type { WriteContext } from '../unifi/writes'
import { liveBus } from '../utils/bus'
import { ownedBlocks } from '../engine/blocks'
import { createAccess } from './access'
import { createSettingsService } from './settings'
import { createAuditService } from './audit'
import { rate } from './cache'
import { wanRates, wanTelemetry } from '../unifi/wan'
import type { ControllerService } from './controller'
import { classifyRoute } from './ownership'
import { routeDestinations, routeTargets } from './route-shape'

const EMPTY = { networks: [], routes: [], activeClients: [], knownClients: [], devices: [], wlans: [] }
function indexByMac(rows: WireStation[]) {
  return new Map(rows.map(station => [station.mac, station]))
}

export function createInventory(db: Db, service: ControllerService, routing?: ReturnType<typeof createRouting>,
  access = createAccess(db, service)) {
  const audit = createAuditService(db)
  const snapshot = () => service.runtime?.cache.snapshot() ?? EMPTY
  const site = () => service.runtime?.config.site ?? 'default'

  function listRoutes() {
    const ownership = service.ownership(site())
    // Never omit routes: unfamiliar shapes are listed read-only (matchingTarget raw, egressId null, OTHER targets).
    return snapshot().routes.flatMap(route => {
      const egressId = Id.safeParse(route.network_id)
      const nextHop = typeof route.next_hop === 'string' && route.next_hop ? route.next_hop : null
      const owner = classifyRoute(route, ownership)
      return [UnifiRoute.parse({
        id: route._id, description: route.description ?? '', enabled: route.enabled,
        matchingTarget: route.matching_target ?? 'UNKNOWN', targets: routeTargets(route), destinations: routeDestinations(route),
        egressId: egressId.success ? egressId.data : null, nextHop, killSwitch: route.kill_switch_enabled ?? false, ownership: owner,
        managedRouteId: owner === 'managed' ? ownership.managed.get(route._id)?.id ?? null : null,
        suspectedAutomation: false, lastExternalChangeAt: null, ...service.runtime?.observations.details(route._id),
      })]
    })
  }

  function egressHealthView(row: typeof egresses.$inferSelect) {
    const gateway = service.runtime?.cache.gateway() ?? null
    const wan = row.kind === 'wan' ? wanStatus(gateway, [], row.wanGroup) : null
    return readHealth(db, row.id)?.value ?? (wan === null ? unknownHealth
      : { ...unknownHealth, status: wan ? 'healthy' : 'down', source: 'unifi' } as const)
  }

  function currentEgresses() {
    const present = new Set(snapshot().networks.map(network => network._id))
    return db.select().from(egresses).where(eq(egresses.site, site())).all()
      .filter(row => present.has(row.id)).sort((a, b) => Number(b.kind === 'wan') - Number(a.kind === 'wan')
        || a.id.localeCompare(b.id, 'en', { numeric: true }))
  }

  function listEgresses() {
    const { routes } = snapshot()
    const counts = new Map<string, number>()
    for (const route of routes) {
      if (route.network_id) counts.set(route.network_id, (counts.get(route.network_id) ?? 0) + 1)
    }
    return Egress.array().parse(currentEgresses().map(row => {
      const probe = routing?.probes.probeState(row)
      const health = egressHealthView(row)
      return {
        ...row, health, publicIp: latestPublicIp(db, row.id), routeCount: counts.get(row.id) ?? 0,
        probe: { enabled: row.probeEnabled, ip: probe?.ip ?? row.probeIp, routeId: probe?.routeId ?? null,
          state: probe?.state ?? (row.probeEnabled ? 'missing' : 'disabled') },
      }
    }))
  }

  function updateEgress(id: string, input: z.output<typeof EgressUpdateInput>, context: WriteContext) {
    const old = listEgresses().find(row => row.id === id)
    if (!old) throw new UnifiError('EGRESS_NOT_FOUND', 404)
    const patch = { color: input.color, probeEnabled: input.probeEnabled }
    if (Object.values(patch).some(value => value !== undefined)) {
      db.update(egresses).set(patch).where(and(eq(egresses.site, site()), eq(egresses.id, id))).run()
      audit.record({
        actor: context.actor, action: 'egress.updated', category: 'egress', severity: 'success',
        target: { type: 'egress', id, label: old.name }, messageKey: 'audit.egress.updated',
        messageParams: { egress: old.name },
      })
      if (input.probeEnabled !== undefined) service.engine.emit('event', { type: 'routing.settings' })
    }
    return listEgresses().find(row => row.id === id)!
  }

  function listClients(query: { online?: boolean, personId?: string, q?: string } = {}) {
    const cache = snapshot()
    const active = indexByMac(cache.activeClients)
    const known = indexByMac(cache.knownClients)
    const names = new Map(cache.devices.map(device => [device.mac, device.name]))
    const networks = new Map(cache.networks.map(network => [network._id, network.name]))
    const assignments = new Map(db.select().from(personDevices).all().map(row => [row.mac, row.personId]))
    const routes = listRoutes().filter(route => route.managedRouteId !== null)
    const term = query.q?.trim().toLowerCase()
    const now = Date.now()
    const today = access.usage.today(now, createSettingsService(db).get().timezone)
    const desired = access.desired(now)
    const own = ownedBlocks(db, service.runtime?.scope)
    return Client.array().parse(db.select().from(clients).all().flatMap(row => {
      const online = active.get(row.mac)
      const personId = assignments.get(row.mac) ?? null
      if (query.online !== undefined && !!online !== query.online || query.personId !== undefined && personId !== query.personId) return []
      const saved = known.get(row.mac)
      const station = online ?? saved
      const hostname = station?.hostname ?? row.hostname
      const unifiName = saved?.name ?? online?.name ?? null
      const displayName = row.alias || unifiName || hostname || row.vendor || row.mac
      const ip = station?.ip ?? null
      if (term && ![displayName, hostname, row.vendor, row.mac, ip].some(value => value?.toLowerCase().includes(term))) return []
      const networkId = station?.network_id || saved?.network_id || null
      const uplinkMac = MacAddress.safeParse(station?.is_wired ? station.sw_mac : station?.ap_mac).data ?? null
      const physicalBlock = saved?.blocked ?? online?.blocked ?? own.has(row.mac)
      const blockReasons = [...(desired.get(row.mac) ?? [])]
      if (physicalBlock && !own.has(row.mac)) blockReasons.push({ source: 'unifi', refId: null, label: 'block.unifi', until: null })
      return [{
        mac: row.mac, displayName, unifiName, hostname, vendor: row.vendor, ip,
        fixedIp: saved?.use_fixedip === false ? null : saved?.fixed_ip ?? online?.fixed_ip ?? null,
        networkId, networkName: (networkId ? networks.get(networkId) : undefined) ?? station?.network ?? null,
        online: !!online, wired: station?.is_wired ?? false, uplinkMac,
        uplinkName: uplinkMac ? names.get(uplinkMac) ?? null : null,
        switchPort: station?.sw_port ?? null, ssid: station?.essid ?? null, signal: station?.signal ?? null,
        randomizedMac: row.randomizedMac, firstSeen: row.firstSeen, lastSeen: row.lastSeen, personId,
        approval: row.approval, blocked: physicalBlock, blockReasons, note: row.note,
        rxRateBps: rate(online?.['rx_bytes-r']), txRateBps: rate(online?.['tx_bytes-r']),
        today: today.get(row.mac) ?? { activeMinutes: 0, bytes: 0 },
        managedRouteIds: routes.flatMap(route =>
          route.managedRouteId && route.targets.some(target => target.type === 'ALL_CLIENTS'
            || (target.type === 'CLIENT' && target.mac === row.mac)
            || (target.type === 'NETWORK' && target.networkId === networkId)) ? [route.managedRouteId] : []),
      }]
    }))
  }

  function client(mac: string) {
    const row = listClients().find(row => row.mac === mac)
    if (!row) throw new UnifiError('CLIENT_NOT_FOUND', 404)
    return row
  }

  function clientChanged(mac: string) {
    liveBus.emit({ type: 'client.changed', data: { macs: [mac] } })
  }

  function updateClient(mac: string, input: z.output<typeof ClientUpdateInput>, context: WriteContext) {
    const previous = client(mac)
    const { alias, note, personId } = input
    db.transaction(tx => {
      if (alias !== undefined || note !== undefined) tx.update(clients).set({ alias, note }).where(eq(clients.mac, mac)).run()
      if (personId === null) tx.delete(personDevices).where(eq(personDevices.mac, mac)).run()
      else if (personId !== undefined && personId !== previous.personId) {
        if (!tx.select().from(people).where(eq(people.id, personId)).get()) throw new UnifiError('PERSON_NOT_FOUND', 404)
        tx.insert(personDevices).values({ mac, personId }).onConflictDoUpdate({
          target: personDevices.mac, set: { personId, presence: false },
        }).run()
      }
    })
    if (Object.keys(input).length) {
      audit.record({
        actor: context.actor, action: 'client.updated', category: 'client', severity: 'success',
        target: { type: 'client', id: mac, label: previous.displayName }, messageKey: 'audit.client.updated',
        messageParams: { mac },
      })
      clientChanged(mac)
      if (personId !== undefined) access.people.changed([previous.personId, personId].filter((id): id is string => !!id))
    }
    return client(mac)
  }

  async function clientAction(mac: string, { action, minutes }: z.output<typeof ClientActionInput>, context: WriteContext) {
    client(mac)
    await access.blocks.action(mac, action, context, access.desired, minutes)
    return client(mac)
  }

  function expireManualBlocks(now = Date.now()) {
    return access.blocks.reconcile(() => access.desired(now), now)
  }

  return {
    routes: listRoutes, clients: listClients, client, updateClient, clientAction, expireManualBlocks,
    clientUsage(mac: string, range: '24h' | '7d' | '30d') {
      client(mac)
      return access.usage.history(mac, range, Date.now(), createSettingsService(db).get().timezone)
    },
    approvals() {
      const pending = db.select().from(clients).where(eq(clients.approval, 'pending')).all()
        .sort((a, b) => (b.detectedAt ?? 0) - (a.detectedAt ?? 0))
      const views = new Map(listClients().map(row => [row.mac, row]))
      return pending.map(row => {
        const view = views.get(row.mac)!
        return { ...view, detectedAt: row.detectedAt ?? row.firstSeen ?? 0,
          quarantined: view.blocked && view.blockReasons.some(item => item.source === 'approval')
            && !view.blockReasons.some(item => item.source === 'unifi') }
      })
    },
    egresses: listEgresses, updateEgress,
    networks: () => snapshot().networks.map(network => ({
      id: network._id, name: network.name, purpose: network.purpose, subnet: network.ip_subnet ?? null,
      vlan: network.vlan_enabled === false ? null : network.vlan ?? null,
    })),
    wlans: () => Wlan.array().parse(snapshot().wlans.map(wlan => ({
      id: wlan._id, name: wlan.name, enabled: wlan.enabled ?? false, security: wlan.security ?? 'unknown', isGuest: wlan.is_guest ?? false,
    }))),
    dashboard() {
      const { activeClients, knownClients } = snapshot()
      const active = indexByMac(activeClients)
      const known = indexByMac(knownClients)
      const owned = ownedBlocks(db, service.runtime?.scope)
      const clientCounts = { online: 0, known: 0, pendingApproval: 0, blocked: 0 }
      for (const { mac, approval } of db.select({ mac: clients.mac, approval: clients.approval }).from(clients).all()) {
        clientCounts.known++
        if (active.has(mac)) clientCounts.online++
        if (approval === 'pending') clientCounts.pendingApproval++
        if (known.get(mac)?.blocked ?? active.get(mac)?.blocked ?? owned.has(mac)) clientCounts.blocked++
      }
      const exits = currentEgresses().map(row => ({ ...row, health: egressHealthView(row) }))
      const cache = service.runtime?.cache
      const gateway = cache?.gateway()
      const at = Date.now()
      const managed = routing?.managed.dashboard(at)
      const fallbackRoutes = routing ? [] : [...service.ownership(site()).managed.values()]
      const enabledWans = exits.filter(exit => exit.kind === 'wan' && exit.enabled).length
      const uplinkRates = wanRates(enabledWans === 1 ? Doc.safeParse(gateway?.uplink).data : null)
      return DashboardSummary.parse({
        generatedAt: at,
        wans: exits.filter(egress => egress.kind === 'wan').map(egress => {
          const wan = wanTelemetry(gateway, egress.wanGroup)
          const rates = wanRates(wan)
          return {
            egressId: egress.id, name: egress.name,
            status: egress.health.status, latencyMs: egress.health.latencyMs,
            publicIp: latestPublicIp(db, egress.id)?.ip ?? (typeof wan?.public_ip === 'string' ? wan.public_ip : null),
            rxBps: rates.rxBps ?? (egress.enabled ? uplinkRates.rxBps : null),
            txBps: rates.txBps ?? (egress.enabled ? uplinkRates.txBps : null),
          }
        }),
        egresses: {
          healthy: exits.filter(exit => exit.health.status === 'healthy').length,
          degraded: exits.filter(exit => exit.health.status === 'degraded').length,
          down: exits.filter(exit => exit.health.status === 'down').length,
          unknown: exits.filter(exit => exit.health.status === 'unknown').length,
        },
        clients: clientCounts,
        people: access.people.counts(at),
        routes: managed?.routes ?? { managed: fallbackRoutes.length, drift: fallbackRoutes.filter(route => route.state === 'drift').length,
          overrides: 0, unifiTotal: snapshot().routes.length },
        upcoming: managed?.upcoming ?? [], recentSwitches: managed?.recentSwitches ?? [], recentAudit: audit.list({ limit: 10 }).items,
        throughput: cache?.throughput() ?? [],
      })
    },
  }
}
