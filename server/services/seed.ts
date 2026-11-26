import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { clients, groups, managedRoutes, people, personDevices, personGroups } from '../db/schema'
import { EGRESS_COLORS } from './cache'

const characters = [
  { name: 'Alex', avatar: '🦊', devices: ['alder-phone', 'maple-desktop', 'atlas-nas'] },
  { name: 'Sam', avatar: '🐙', devices: ['field-pixel', 'mesa-laptop'] },
  { name: 'Jordan', avatar: '🐼', devices: ['juniper-phone', 'orbit-switch', 'cove-tab'] },
  { name: 'Taylor', avatar: '🐸', devices: ['finch-phone', 'river-console', 'daybreak-tablet'] },
]

export function seedMockDemo(db: Db, now = Date.now()) {
  db.transaction(tx => {
    if (tx.select({ id: people.id }).from(people).limit(1).get()
      || tx.select({ id: managedRoutes.id }).from(managedRoutes).limit(1).get()) return
    const byHost = new Map(tx.select().from(clients).all().map(row => [row.hostname, row.mac]))
    if (!characters.every(character => character.devices.every(host => byHost.has(host)))) return
    const groupId = 'demo-kids'
    tx.insert(groups).values({ id: groupId, name: 'Kids', color: '#8E59FF' }).onConflictDoNothing().run()
    for (const [index, character] of characters.entries()) {
      const id = `demo-person-${index + 1}`
      tx.insert(people).values({ id, name: character.name, avatar: character.avatar, color: EGRESS_COLORS[index]!, createdAt: now }).run()
      if (index >= 2) tx.insert(personGroups).values({ groupId, personId: id }).run()
      for (const [deviceIndex, hostname] of character.devices.entries()) {
        const mac = byHost.get(hostname)!
        tx.insert(personDevices).values({ mac, personId: id, presence: deviceIndex === 0 }).onConflictDoNothing().run()
        tx.update(clients).set({ approval: 'approved' }).where(eq(clients.mac, mac)).run()
      }
    }
    // Future work packages can extend the demo within this transaction.
  })
}
