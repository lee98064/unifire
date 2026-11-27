import { and, eq, isNull, sql } from 'drizzle-orm'
import { PoeQualification } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { poeApplied, poeGrace, poeOffLog, poeSchedules, settings } from '../../db/schema'
import { MINUTE } from '../access-time'
import { portKey, type PortKey } from './port-history'
import { portIndex } from '../../unifi/poe-ports'
import type { createDeviceGraph } from './poe-safety'

export const poeQualificationKey = (scope: string) => `poe.qualification.${scope}`

export function invalidatePoeQualification(db: Db, scope: string, version: string | null) {
  db.delete(settings).where(and(eq(settings.key, poeQualificationKey(scope)),
    sql`json_extract(${settings.value}, '$.version') is not ${version}`)).run()
}

export function readPoeQualification(db: Db, scope: string | undefined, version: string | null) {
  const saved = scope && version ? db.select().from(settings).where(eq(settings.key, poeQualificationKey(scope))).get()?.value : null
  return saved && typeof saved === 'object' && 'version' in saved && saved.version === version
    ? PoeQualification.parse(saved) : PoeQualification.parse({ qualified: false, at: null, switchMac: null, portIdx: null, error: null })
}

export function heldPort(db: Pick<Db, 'select'>, key: PortKey) {
  return db.select().from(poeApplied).where(portKey(poeApplied, key)).get()
}

function planLabel(db: Pick<Db, 'select'>, hold: typeof poeApplied.$inferSelect | undefined) {
  if (!hold?.scheduleId) return hold?.label
  return db.select({ name: poeSchedules.name }).from(poeSchedules).where(eq(poeSchedules.id, hold.scheduleId)).get()?.name ?? hold.label
}

export function plannedPoePorts(db: Pick<Db, 'select'>, scope: string, at: number, graph: ReturnType<typeof createDeviceGraph>) {
  const ports = new Map<string, string>()
  for (const row of db.select().from(poeGrace).where(eq(poeGrace.scope, scope)).all()) {
    if (row.until > at) ports.set(row.switchMac + '/' + row.portIdx, row.label ?? row.switchMac + ':' + row.portIdx)
  }
  for (const row of db.select().from(poeApplied).where(eq(poeApplied.scope, scope)).all()) {
    const port = graph.byMac.get(row.switchMac)?.port_table?.find(port => portIndex(port.port_idx) === row.portIdx)
    if (row.phase === 'applying' && port?.poe_mode !== 'off') continue
    ports.set(row.switchMac + '/' + row.portIdx, planLabel(db, row)
      ?? (typeof port?.name === 'string' ? port.name : row.switchMac + ':' + row.portIdx))
  }
  return ports
}

export function plannedPower(mac: string, parents: ReadonlyMap<string, { mac: string, port: number | null }>, ports: ReadonlyMap<string, string>) {
  const seen = new Set<string>()
  while (!seen.has(mac)) {
    seen.add(mac)
    const parent = parents.get(mac)
    if (!parent) return undefined
    const label = parent.port === null ? undefined : ports.get(parent.mac + '/' + parent.port)
    if (label !== undefined) return label
    mac = parent.mac
  }
  return undefined
}

export function releasePoe(db: Pick<Db, 'insert' | 'update' | 'delete' | 'select'>, key: PortKey, at: number, restored: boolean) {
  const hold = heldPort(db, key)
  db.update(poeOffLog).set({ end: at }).where(and(portKey(poeOffLog, key), isNull(poeOffLog.end))).run()
  db.delete(poeApplied).where(portKey(poeApplied, key)).run()
  if (restored || hold?.phase === 'held') {
    const label = planLabel(db, hold) ?? null
    const until = at + 10 * MINUTE
    db.insert(poeGrace).values({ ...key, until, label }).onConflictDoUpdate({
      target: [poeGrace.scope, poeGrace.switchMac, poeGrace.portIdx], set: { until, label },
    }).run()
  }
}
