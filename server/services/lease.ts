import { and, eq, gt, lte } from 'drizzle-orm'
import { useDb } from '../db'
import { leases } from '../db/schema'

export const ENGINE_LEASE = 'engine'

export function acquireLease(name: string, owner: string, ttlMs: number, db = useDb(), now = Date.now()) {
  return db.insert(leases).values({ name, owner, expiresAt: now + ttlMs })
    .onConflictDoUpdate({
      target: leases.name,
      set: { owner, expiresAt: now + ttlMs },
      setWhere: lte(leases.expiresAt, now),
    }).run().changes === 1
}

export function renewLease(name: string, owner: string, ttlMs: number, db = useDb(), now = Date.now()) {
  return db.update(leases).set({ expiresAt: now + ttlMs }).where(and(
    eq(leases.name, name), eq(leases.owner, owner), gt(leases.expiresAt, now),
  )).run().changes === 1
}

export function releaseLease(name: string, owner: string, db = useDb()) {
  return db.delete(leases).where(and(eq(leases.name, name), eq(leases.owner, owner))).run().changes === 1
}
