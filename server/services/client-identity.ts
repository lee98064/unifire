import type { Db } from '../db'
import { clients, personDevices } from '../db/schema'
import type { WireStation } from '../unifi/endpoints/schemas'

export function clientDisplayName(row: Pick<typeof clients.$inferSelect, 'mac' | 'alias' | 'vendor'>,
  unifiName: string | null | undefined, hostname: string | null | undefined) {
  return row.alias || unifiName || hostname || row.vendor || row.mac
}

export function clientIdentities(db: Db, active: readonly WireStation[], known: readonly WireStation[]) {
  const activeByMac = new Map(active.map(row => [row.mac, row]))
  const knownByMac = new Map(known.map(row => [row.mac, row]))
  const assignments = new Map(db.select().from(personDevices).all().map(row => [row.mac, row.personId]))
  return new Map(db.select().from(clients).all().map(row => {
    const online = activeByMac.get(row.mac)
    const saved = knownByMac.get(row.mac)
    return [row.mac, {
      name: clientDisplayName(row, saved?.name ?? online?.name, (online ?? saved)?.hostname ?? row.hostname),
      personId: assignments.get(row.mac) ?? null,
    }]
  }))
}
