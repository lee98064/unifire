import { and, eq, lte } from 'drizzle-orm'
import { z } from 'zod'
import { Client, ClientActionInput, ClientUpdateInput } from '#shared/schemas/access'
import { Wlan } from '#shared/schemas/automation'
import { Id } from '#shared/schemas/common'
import { Egress, EgressUpdateInput } from '#shared/schemas/egress'
import { MatchingTarget, RouteTarget, UnifiRoute, type RouteTargetT } from '#shared/schemas/routes'
import { DashboardSummary } from '#shared/schemas/system'
import type { Db } from '../db'
import { blocks, clients, egresses, people, personDevices } from '../db/schema'
import { MacAddress, type WireRoute, type WireStation } from '../unifi/endpoints/schemas'
import { UnifiError } from '../unifi/errors'
import type { WriteContext } from '../unifi/writes'
import { liveBus } from '../utils/bus'
import { createAuditService } from './audit'
import { rate } from './cache'
import type { ControllerService } from './controller'
import { classifyRoute } from './ownership'

const EMPTY = { networks: [], routes: [], activeClients: [], knownClients: [], devices: [], wlans: [] }
const text = z.string()

function targets(route: WireRoute) {
  return route.target_devices.flatMap((value): RouteTargetT[] => {
    const mac = MacAddress.safeParse(value.client_mac).data
    const result = RouteTarget.safeParse({ type: value.type, mac, networkId: value.network_id })
    return result.success ? [result.data] : []
  })
}

function destinations(route: WireRoute): string[] {
  if (route.matching_target === 'REGION') return route.regions ?? []
  if (route.matching_target === 'DOMAIN') {
    return (route.domains ?? []).flatMap(value => typeof value === 'string' ? [value] : text.safeParse(value.domain).data ?? [])
  }
  if (route.matching_target === 'IP') {
    return [
      ...(route.ip_addresses ?? []).flatMap(value => typeof value === 'string' ? [value] : text.safeParse(value.ip_or_subnet).data ?? []),
      ...(route.ip_ranges ?? []).flatMap(value => typeof value.ip_start === 'string' && typeof value.ip_stop === 'string'
        ? [`${value.ip_start}–${value.ip_stop}`] : []),
    ]
  }
  return []
}

function indexByMac(rows: WireStation[]) {
  return new Map(rows.map(station => [station.mac, station]))
}

export function createInventory(db: Db, service: ControllerService) {
  const audit = createAuditService(db)
  const snapshot = () => service.runtime?.cache.snapshot() ?? EMPTY
  const site = () => service.runtime?.config.site ?? 'default'

  function listRoutes() {
    const ownership = service.ownership(site())
    return snapshot().routes.flatMap(route => {
      const match = MatchingTarget.safeParse(route.matching_target)
      const egressId = Id.safeParse(route.network_id || route.next_hop)
      if (!match.success || !egressId.success) return []
      const owner = classifyRoute(route, ownership)
      return [UnifiRoute.parse({
        id: route._id, description: route.description ?? '', enabled: route.enabled,
        matchingTarget: match.data, targets: targets(route), destinations: destinations(route),
        egressId: egressId.data, killSwitch: route.kill_switch_enabled ?? false, ownership: owner,
        managedRouteId: owner === 'managed' ? ownership.managed.get(route._id)?.id ?? null : null,
        suspectedAutomation: false, lastExternalChangeAt: null,
      })]
    })
  }

  function listEgresses() {
    const { networks, routes } = snapshot()
    const present = new Set(networks.map(network => network._id))
    const counts = new Map<string, number>()
    for (const route of routes) {
      if (route.network_id) counts.set(route.network_id, (counts.get(route.network_id) ?? 0) + 1)
    }
    return Egress.array().parse(db.select().from(egresses).where(eq(egresses.site, site())).all()
      .filter(row => present.has(row.id)).sort((a, b) => Number(b.kind === 'wan') - Number(a.kind === 'wan')
        || a.id.localeCompare(b.id, 'en', { numeric: true })).map(row => ({
        ...row,
        health: { status: 'unknown', latencyMs: null, lossPct: null, jitterMs: null, lastCheckAt: null, since: null, source: 'none' },
        probe: { enabled: row.probeEnabled, ip: row.probeIp, routeId: row.probeRouteId,
          state: !row.probeEnabled ? 'disabled' : row.probeRouteId && routes.some(route => route._id === row.probeRouteId) ? 'ok' : 'missing' },
        publicIp: null, routeCount: counts.get(row.id) ?? 0,
      })))
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
    const byBlock = new Map<string, (typeof blocks.$inferSelect)[]>()
    for (const block of db.select().from(blocks).all()) {
      const entries = byBlock.get(block.mac) ?? []
      entries.push(block)
      byBlock.set(block.mac, entries)
    }
    const routes = listRoutes().filter(route => route.managedRouteId !== null)
    const term = query.q?.trim().toLowerCase()
    const now = Date.now()
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
      const entries = byBlock.get(row.mac) ?? []
      const physicalBlock = saved?.blocked ?? online?.blocked ?? entries.some(block => block.applied)
      const blockReasons = entries.filter(block => block.applied || block.source !== 'manual' && (block.until === null || block.until > now))
        .map(block => ({ source: block.source, refId: block.refId, label: block.label, until: block.until }))
      if (physicalBlock && !entries.some(block => block.applied)) {
        blockReasons.push({ source: 'unifi', refId: null, label: 'block.unifi', until: null })
      }
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
        today: { activeMinutes: 0, bytes: 0 },
        managedRouteIds: routes.flatMap(route =>
          route.managedRouteId && route.targets.some(target => target.type === 'ALL_CLIENTS'
            || (target.type === 'CLIENT' ? target.mac === row.mac : target.networkId === networkId)) ? [route.managedRouteId] : []),
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
    }
    return client(mac)
  }

  async function clientAction(mac: string, { action, minutes }: z.output<typeof ClientActionInput>, context: WriteContext, expiresAt?: number) {
    const runtime = service.runtime
    if (!runtime) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    client(mac)
    const manualId = `manual:${mac}`
    const remove = () => db.delete(blocks).where(and(eq(blocks.mac, mac), eq(blocks.source, 'manual'))).run()
    const fresh = async () => {
      const known = await runtime.api.knownClients()
      const row = known.find(row => row.mac === mac)
      if (row?.blocked != null) return row.blocked
      return (await runtime.api.activeClients()).find(row => row.mac === mac)?.blocked
    }

    const result = await runtime.writes.clientAction(mac, action, context, async () => {
      if (action === 'kick') return { send: true }
      const now = Date.now()
      const entries = db.select().from(blocks).where(eq(blocks.mac, mac)).all()
      const manual = entries.find(block => block.source === 'manual')
      const others = entries.filter(block => block.source !== 'manual')
      const external = others.some(block => block.source === 'unifi')
      const otherManagedReason = others.some(block => block.applied || block.until === null || block.until > now)
      if (expiresAt !== undefined && manual?.until !== expiresAt) return { send: false }
      const wasBlocked = await fresh()
      if (wasBlocked == null) throw new UnifiError('UNIFI_CLIENT_STATE_UNKNOWN')
      const desired = action === 'block'
      const verify = async () => {
        if (await fresh() !== desired) throw new UnifiError('UNIFI_VERIFY_FAILED')
      }

      if (action === 'unblock') {
        if (!manual?.applied || external) {
          if (expiresAt === undefined && wasBlocked && !manual?.applied) throw new UnifiError('UNIFI_BLOCK_NOT_OWNED')
          return { wasBlocked, send: false, commit: remove }
        }
        return { wasBlocked, send: wasBlocked && !otherManagedReason, verify, commit: remove }
      }
      if (wasBlocked && (external || !manual?.applied && !others.some(block => block.applied))) {
        // Preserve administrator-owned UniFi blocks.
        return { wasBlocked, send: false }
      }
      return {
        wasBlocked, send: !wasBlocked, verify,
        commit() {
          db.transaction(() => {
            remove()
            db.insert(blocks).values({
              id: manualId, mac, source: 'manual', label: 'block.manual', applied: true,
              until: minutes === undefined ? null : now + minutes * 60_000,
            }).run()
          })
        },
      }
    })
    if (!result.dryRun) {
      await Promise.allSettled([runtime.cache.refresh('activeClients'), runtime.cache.refresh('knownClients')])
      clientChanged(mac)
    }
    return client(mac)
  }

  async function expireManualBlocks(now = Date.now()) {
    if (!service.runtime || service.status().mode !== 'live') return
    const expired = db.select().from(blocks).where(and(eq(blocks.source, 'manual'), lte(blocks.until, now))).all()
    for (const block of expired) {
      if (block.until !== null) {
        await clientAction(block.mac, { action: 'unblock' }, {
          actor: { type: 'system', id: null, name: null },
        }, block.until).catch(() => {})
      }
    }
  }

  return {
    routes: listRoutes, clients: listClients, client, updateClient, clientAction, expireManualBlocks,
    egresses: listEgresses, updateEgress,
    networks: () => snapshot().networks.map(network => ({
      id: network._id, name: network.name, purpose: network.purpose, subnet: network.ip_subnet ?? null,
      vlan: network.vlan_enabled === false ? null : network.vlan ?? null,
    })),
    wlans: () => Wlan.array().parse(snapshot().wlans.map(wlan => ({
      id: wlan._id, name: wlan.name, enabled: wlan.enabled ?? false, security: wlan.security ?? 'unknown', isGuest: wlan.is_guest ?? false,
    }))),
    dashboard() {
      const allClients = listClients()
      const exits = listEgresses()
      const cache = service.runtime?.cache
      const gateway = cache?.gateway()
      const routes = [...service.ownership(site()).managed.values()]
      const peopleRows = db.select().from(people).all()
      return DashboardSummary.parse({
        generatedAt: Date.now(),
        wans: exits.filter(egress => egress.kind === 'wan').map(egress => {
          const group = egress.wanGroup?.toLowerCase()
          const wan = group === 'wan' || group === 'wan1' ? gateway?.wan1
            : group === 'wan2' ? gateway?.wan2 : group === 'wan3' ? gateway?.wan3 : undefined
          return {
            egressId: egress.id, name: egress.name,
            status: wan?.up === true ? 'healthy' : wan?.up === false ? 'down' : 'unknown',
            latencyMs: null, publicIp: typeof wan?.public_ip === 'string' ? wan.public_ip : null,
            rxBps: rate(wan?.['rx_bytes-r']), txBps: rate(wan?.['tx_bytes-r']),
          }
        }),
        egresses: { healthy: 0, degraded: 0, down: 0, unknown: exits.length },
        clients: { online: allClients.filter(client => client.online).length, known: allClients.length,
          pendingApproval: allClients.filter(client => client.approval === 'pending').length,
          blocked: allClients.filter(client => client.blocked).length },
        people: { home: 0, total: peopleRows.length,
          paused: peopleRows.filter(person => person.paused && (person.pausedUntil === null || person.pausedUntil > Date.now())).length },
        routes: { managed: routes.length, drift: routes.filter(route => route.state === 'drift').length,
          overrides: 0, unifiTotal: snapshot().routes.length },
        upcoming: [], recentSwitches: [], recentAudit: audit.list({ limit: 10 }).items,
        throughput: cache?.throughput() ?? [],
      })
    },
  }
}
