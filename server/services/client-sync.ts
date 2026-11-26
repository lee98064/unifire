import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { clients, settings } from '../db/schema'
import type { WireStation } from '../unifi/endpoints/schemas'
import type { EngineEvents } from '../unifi/ws'
import type { liveBus } from '../utils/bus'
import { createAuditService } from './audit'
import { macVendor } from './oui'
import { createSettingsService } from './settings'

const baselineKey = 'access.clientBaseline'

export function wireTime(value?: number | null) {
  if (value == null || value < 0) return null
  return Math.floor(value < 1e12 ? value * 1000 : value)
}

export function createClientSync(db: Db, scope: string, engine: EngineEvents, bus: typeof liveBus) {
  const audit = createAuditService(db, bus)
  const config = createSettingsService(db)
  let baseline = db.select().from(settings).where(eq(settings.key, baselineKey)).get()?.value === scope
  let active: WireStation[] | undefined
  let known: WireStation[] | undefined

  return (rows: WireStation[], online: boolean, at: number) => {
    if (online) active = rows
    else known = rows
    if (!baseline && (!active || !known)) return false
    const imported = !baseline
    const stations = new Map((imported ? known! : rows).map(row => [row.mac, row]))
    if (imported) {
      for (const row of active!) stations.set(row.mac, { ...stations.get(row.mac), ...row })
    }
    const onlineMacs = new Set((online || imported ? active ?? [] : []).map(row => row.mac))
    const approval = config.get().approval
    const detected = db.transaction(tx => {
      const existing = tx.select().from(clients).all()
      const previous = new Map(existing.map(client => [client.mac, client]))
      const approvedHostnames = new Set(existing.filter(row => row.approval === 'approved' && row.hostname)
        .map(row => row.hostname!.trim().toLowerCase()))
      const newcomers: { mac: string, displayName: string, requiresApproval: boolean }[] = []
      for (const station of stations.values()) {
        const old = previous.get(station.mac)
        const first = wireTime(station.first_seen) ?? at
        const firstSeen = Math.min(old?.firstSeen ?? first, first)
        const lastSeen = Math.max(old?.lastSeen ?? 0, wireTime(station.last_seen) ?? 0, onlineMacs.has(station.mac) ? at : 0) || null
        const { vendor, randomizedMac } = macVendor(station.mac, station.oui)
        const hostname = station.hostname || old?.hostname || null
        const fields = { hostname, vendor: vendor ?? old?.vendor ?? null, randomizedMac, firstSeen, lastSeen }
        if (old) {
          const grandfather = imported && old.approval === 'pending'
          tx.update(clients).set({ ...fields, ...(grandfather && { approval: 'approved', detectedAt: null }) })
            .where(eq(clients.mac, station.mac)).run()
          continue
        }
        const check = !imported && approval.mode !== 'off'
        const matched = check && approval.matchRandomizedByHostname && randomizedMac
          && !!hostname?.trim() && approvedHostnames.has(hostname.trim().toLowerCase())
        const requiresApproval = check && !matched
        tx.insert(clients).values({ mac: station.mac, ...fields, approval: requiresApproval ? 'pending' : 'approved',
          detectedAt: requiresApproval ? at : null }).run()
        if (matched) {
          audit.record({ actor: { type: 'system', id: null, name: null }, category: 'client', action: 'approval.hostnameMatched',
            severity: 'info', target: { type: 'client', id: station.mac, label: hostname! },
            messageKey: 'audit.approval.hostnameMatched', messageParams: { mac: station.mac, hostname: hostname! } })
        }
        if (check) newcomers.push({ mac: station.mac, displayName: station.name || hostname || vendor || station.mac, requiresApproval })
      }
      if (imported) tx.insert(settings).values({ key: baselineKey, value: scope }).onConflictDoUpdate({
        target: settings.key, set: { value: scope },
      }).run()
      return newcomers
    })
    baseline = true
    for (const { mac, displayName, requiresApproval } of detected) {
      engine.emit('event', { type: 'client.new', mac, displayName })
      if (requiresApproval) {
        engine.emit('event', { type: 'notification', event: 'new_device', mac, displayName })
        bus.emit({ type: 'approval.new', data: { mac, displayName } })
      }
    }
    return true
  }
}
