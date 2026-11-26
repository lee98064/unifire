import { and, eq, isNull, sql } from 'drizzle-orm'
import { PoeQualification } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { poeApplied, poeGrace, poeOffLog, settings } from '../../db/schema'
import { MINUTE } from '../access-time'
import { portKey, type PortKey } from './port-history'

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

export function releasePoe(db: Pick<Db, 'insert' | 'update' | 'delete'>, key: PortKey, at: number, restored: boolean) {
  db.update(poeOffLog).set({ end: at }).where(and(portKey(poeOffLog, key), isNull(poeOffLog.end))).run()
  db.delete(poeApplied).where(portKey(poeApplied, key)).run()
  if (restored) {
    const until = at + 10 * MINUTE
    db.insert(poeGrace).values({ ...key, until }).onConflictDoUpdate({
      target: [poeGrace.scope, poeGrace.switchMac, poeGrace.portIdx], set: { until },
    }).run()
  }
}
