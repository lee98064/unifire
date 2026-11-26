import { emptyGrid, generateGrid } from '#shared/utils/schedule'
import { FailoverPolicy, type RouteScheduleT } from '#shared/schemas/routes'
import reference from '../../docs/reference-egress-schedule.json'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { clients, egresses, groups, managedRoutes, people, personDevices, personGroups, routeOverrides, routeSchedules, settings } from '../db/schema'
import { DEMO_ROUTES } from '../unifi/mock/fixtures'
import type { WireRoute } from '../unifi/endpoints/schemas'
import { routeFingerprint } from './ownership'
import { managedRouteShape } from './route-shape'
import { createSettingsService } from './settings'
import { EGRESS_COLORS } from './cache'

const characters = [
  { name: 'Alex', avatar: '🦊', devices: ['alder-phone', 'maple-desktop', 'atlas-nas'] },
  { name: 'Sam', avatar: '🐙', devices: ['field-pixel', 'mesa-laptop'] },
  { name: 'Jordan', avatar: '🐼', devices: ['juniper-phone', 'orbit-switch', 'cove-tab'] },
  { name: 'Taylor', avatar: '🐸', devices: ['finch-phone', 'river-console', 'daybreak-tablet'] },
]

export function seedMockDemo(db: Db, docs: WireRoute[], now = Date.now()) {
  db.transaction(tx => {
    const byHost = new Map(tx.select().from(clients).all().map(row => [row.hostname, row.mac]))
    if (!tx.select({ id: people.id }).from(people).limit(1).get()
      && characters.every(character => character.devices.every(host => byHost.has(host)))) {
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
    }
    const alreadySeeded = tx.select().from(settings).where(eq(settings.key, 'routing.demoSeeded')).get()
    if (alreadySeeded || tx.select({ id: managedRoutes.id }).from(managedRoutes).limit(1).get()
      || Object.values(DEMO_ROUTES).some(id => !docs.some(doc => doc._id === id))) return
    const days = [0, 1, 2, 3, 4, 5, 6]
    const generator: NonNullable<RouteScheduleT['generator']> = {
      pinned: [{ hour: 0, egressId: 'demo-wan-1' }],
      cycle: reference.vpn_cycle.map(exit => `demo-vpn-${Number(exit.id.split('-').at(-1)) - 1}`),
      continuity: 'daily-reset', days,
    }
    const kidsGrid = emptyGrid('demo-wan-2').map(day => day.map((egressId, hour) => hour >= 18 ? 'demo-vpn-4' : egressId))
    const timezone = createSettingsService(db).get().timezone
    for (const [key, unifiRouteId] of Object.entries(DEMO_ROUTES)) {
      if (key === 'external') continue
      const doc = docs.find(doc => doc._id === unifiRouteId)
      if (!doc?.network_id) continue
      const routeShape = managedRouteShape(doc)
      if (!routeShape) continue
      const id = `demo-managed-${key}`
      tx.insert(managedRoutes).values({ id, unifiRouteId, controllerScope: 'mock:default',
        name: doc.description ?? id, defaultEgressId: doc.network_id, baselineFingerprint: routeFingerprint(doc),
        routeShape, state: 'active', createdAt: now, failover: FailoverPolicy.parse({
          enabled: key === 'kids', chain: key === 'kids' ? ['demo-wan-2', 'demo-wan-1', 'demo-vpn-1'] : [],
        }),
      }).run()
      if (key === 'proxy') tx.insert(routeSchedules).values({ managedRouteId: id, timezone, grid: generateGrid(generator), generator }).run()
      if (key === 'kids') tx.insert(routeSchedules).values({ managedRouteId: id, timezone, grid: kidsGrid }).run()
      if (key === 'nas') tx.insert(routeOverrides).values({ id: 'demo-override-nas', managedRouteId: id, egressId: 'demo-vpn-2',
        startsAt: now, endsAt: now + 2 * 60 * 60_000, createdBy: 'system:demo', reason: null }).run()
    }
    const excludedRouteIds = createSettingsService(db).get().excludedRouteIds
    const value = [...new Set([...excludedRouteIds, DEMO_ROUTES.external])]
    tx.insert(settings).values({ key: 'excludedRouteIds', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } }).run()
    tx.insert(settings).values({ key: 'routing.demoSeeded', value: true }).run()
    for (const exit of tx.select().from(egresses).all()) {
      if (exit.id.startsWith('demo-')) tx.update(egresses).set({ probeEnabled: true }).where(eq(egresses.id, exit.id)).run()
    }
  })
}
