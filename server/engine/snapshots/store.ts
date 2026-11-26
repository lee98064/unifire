import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { and, desc, eq, gte, lt, notInArray, or } from 'drizzle-orm'
import { Snapshot, SnapshotResource, type SnapshotResourceT, type SnapshotT } from '#shared/schemas/insight'
import type { Db } from '../../db'
import { snapshots, snapshotItems, snapshotRestoreIds } from '../../db/schema'
import { decodeCursor } from '../../services/audit'
import { parseWire } from '../../unifi/endpoints'
import { Doc } from '../../unifi/endpoints/schemas'
import { apiError } from '../../utils/api-error'
import { decrypt, encrypt } from '../../utils/crypto'
import { compareMaps, type Collections, type SnapshotEntry } from './diff'

export const DAY = 86_400_000
export type Capture = { collections: Collections, failed: SnapshotResourceT[], networkVersion: string | null }
const snapshotDocument = z.record(z.string(), z.json())
const newest = [desc(snapshots.ts), desc(snapshots.id)] as const

export function createSnapshotStore(db: Db) {
  function get(id: string) {
    const row = db.select().from(snapshots).where(eq(snapshots.id, id)).get()
    if (!row) throw apiError(404, 'SNAPSHOT_NOT_FOUND', 'errors.snapshotNotFound')
    return row
  }

  function documents(id: string, unreadable?: Set<SnapshotResourceT>): Collections {
    const collections: Collections = new Map()
    for (const item of db.select().from(snapshotItems).where(eq(snapshotItems.snapshotId, id)).all()) {
      const entries = collections.get(item.resource) ?? new Map<string, SnapshotEntry>()
      if (unreadable?.has(item.resource)) continue
      try {
        entries.set(item.itemId, decode(item))
        collections.set(item.resource, entries)
      } catch (error) {
        if (!unreadable) throw error
        unreadable.add(item.resource)
        collections.delete(item.resource)
      }
    }
    return collections
  }

  function decode(row: typeof snapshotItems.$inferSelect): SnapshotEntry {
    return { id: row.itemId, label: row.label, hash: row.hash, doc: parseWire(Doc, decrypt(row.encryptedDoc)) }
  }

  function item(id: string, resource: SnapshotResourceT, itemId: string) {
    const row = db.select().from(snapshotItems).where(and(eq(snapshotItems.snapshotId, id),
      eq(snapshotItems.resource, resource), eq(snapshotItems.itemId, itemId))).get()
    if (!row) throw apiError(404, 'SNAPSHOT_ITEM_NOT_FOUND', 'errors.snapshotItemNotFound')
    return decode(row)
  }

  function list({ cursor, limit }: { cursor?: string, limit: number }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
    const after = cursor === undefined ? null : decodeCursor(cursor)
    const rows = db.select().from(snapshots).where(after ? or(lt(snapshots.ts, after[0]),
      and(eq(snapshots.ts, after[0]), lt(snapshots.id, after[1]))) : undefined).orderBy(...newest).limit(limit + 1).all()
    const items = rows.slice(0, limit).map(row => Snapshot.parse(row))
    const last = items.at(-1)
    const nextCursor = rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.ts, last.id])).toString('base64url') : null
    return { items, nextCursor }
  }

  function recent(scope: string, since: number) {
    return db.select().from(snapshots).where(and(eq(snapshots.controllerScope, scope),
      gte(snapshots.ts, since))).orderBy(...newest).get()
  }

  function prune(cutoff: number) {
    const protectedIds = db.select({ id: snapshots.id }).from(snapshots).orderBy(...newest).limit(3)
    db.delete(snapshots).where(and(lt(snapshots.ts, cutoff), notInArray(snapshots.id, protectedIds))).run()
  }

  function persist(scope: string, capture: Capture, trigger: SnapshotT['trigger'], ts: number, note: string | null, retainDays: number) {
    const { collections, failed, networkVersion } = capture
    const id = randomUUID()
    const counts = Object.fromEntries(SnapshotResource.options.map(resource => [resource, collections.get(resource)?.size ?? 0]))
    const items = [...collections].flatMap(([resource, entries]) => [...entries.values()].map(entry => ({
      snapshotId: id, resource, itemId: entry.id, label: entry.label, hash: entry.hash, encryptedDoc: encrypt(snapshotDocument.parse(entry.doc)),
    })))
    return db.transaction(tx => {
      const previous = tx.select().from(snapshots).where(eq(snapshots.controllerScope, scope)).orderBy(...newest).get()
      let changeCount: number | null = null
      if (previous) {
        const old = new Map<SnapshotResourceT, Map<string, { hash: string }>>()
        for (const row of tx.select({ resource: snapshotItems.resource, itemId: snapshotItems.itemId, hash: snapshotItems.hash })
          .from(snapshotItems).where(eq(snapshotItems.snapshotId, previous.id)).all()) {
          const items = old.get(row.resource) ?? new Map()
          items.set(row.itemId, row)
          old.set(row.resource, items)
        }
        const comparable = SnapshotResource.options.filter(resource => !previous.failed.includes(resource) && !failed.includes(resource))
        if (comparable.length) changeCount = comparable.reduce((count, resource) =>
          count + [...compareMaps(old.get(resource) ?? new Map(), collections.get(resource) ?? new Map())].length, 0)
      }
      const row = Snapshot.parse({ id, ts, trigger, note, networkVersion, complete: !failed.length, failed, counts, changeCount,
        sizeBytes: items.reduce((sum, item) => sum + Buffer.byteLength(item.encryptedDoc), 0) })
      tx.insert(snapshots).values({ ...row, controllerScope: scope }).run()
      for (const item of items) tx.insert(snapshotItems).values(item).run()
      prune(ts - retainDays * DAY)
      return row
    })
  }

  function resolveId(scope: string, resource: SnapshotResourceT, id: string) {
    return db.select().from(snapshotRestoreIds).where(and(eq(snapshotRestoreIds.scope, scope),
      eq(snapshotRestoreIds.resource, resource), eq(snapshotRestoreIds.originalId, id))).get()?.currentId ?? id
  }

  function mappedIds(scope: string) {
    return db.select().from(snapshotRestoreIds).where(eq(snapshotRestoreIds.scope, scope)).all()
  }

  function remap(scope: string, resource: SnapshotResourceT, originalId: string, priorId: string, currentId: string) {
    if (priorId === currentId) return
    db.update(snapshotRestoreIds).set({ currentId }).where(and(eq(snapshotRestoreIds.scope, scope),
      eq(snapshotRestoreIds.resource, resource), eq(snapshotRestoreIds.currentId, priorId))).run()
    const mapping = { scope, resource, originalId, currentId }
    db.insert(snapshotRestoreIds).values(mapping).onConflictDoUpdate({
      target: [snapshotRestoreIds.scope, snapshotRestoreIds.resource, snapshotRestoreIds.originalId], set: { currentId },
    }).run()
  }

  function remove(id: string) {
    if (!db.delete(snapshots).where(eq(snapshots.id, id)).run().changes) {
      throw apiError(404, 'SNAPSHOT_NOT_FOUND', 'errors.snapshotNotFound')
    }
    return { ok: true } as const
  }

  return { get, documents, item, list, recent, persist, prune, resolveId, mappedIds, remap, remove }
}
