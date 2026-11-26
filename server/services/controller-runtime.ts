import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { UnifiError } from '../unifi/errors'
import { createControllerService, type ControllerService } from './controller'
import { createInventory } from './inventory'
import { acquireLease, ENGINE_LEASE, releaseLease, renewLease } from './lease'

let current: ControllerService | undefined
let starting: Promise<() => Promise<void>> | undefined

export async function useController() {
  if (!current) await starting
  if (!current) throw new UnifiError('UNIFI_INACTIVE')
  return current
}

const TTL = 45_000

export function startControllerRuntime(db: Db, mock: boolean, lively: boolean) {
  starting = runControllerRuntime(db, mock, lively)
  return starting
}

async function runControllerRuntime(db: Db, mock: boolean, lively: boolean) {
  const owner = randomUUID()
  let expiresAt = 0
  let stopping = false
  let maintenance: Promise<void> | undefined
  let inventory: ReturnType<typeof createInventory> | undefined
  let expiry: Promise<void> | undefined

  async function maintain() {
    if (stopping) return
    const now = Date.now()
    if (current && renewLease(ENGINE_LEASE, owner, TTL, db, now)) {
      expiresAt = now + TTL
      return
    }
    if (current) {
      const stale = current
      current = undefined
      inventory = undefined
      expiresAt = 0
      await stale.stop()
    }
    if (stopping || !acquireLease(ENGINE_LEASE, owner, TTL, db, now)) return
    expiresAt = now + TTL
    try {
      current = await createControllerService(db, { mock, lively, active: () => Date.now() < expiresAt })
      inventory = createInventory(db, current)
    } catch (error) {
      expiresAt = 0
      releaseLease(ENGINE_LEASE, owner, db)
      throw error
    }
  }

  await maintain()
  const heartbeat = setInterval(() => {
    if (maintenance) return
    maintenance = maintain().catch(() => {}).finally(() => { maintenance = undefined })
  }, 10_000)
  heartbeat.unref()
  const expire = setInterval(() => {
    if (expiry || !inventory || Date.now() >= expiresAt) return
    expiry = inventory.expireManualBlocks().catch(() => {}).finally(() => { expiry = undefined })
  }, 15_000)
  expire.unref()

  return async () => {
    stopping = true
    clearInterval(heartbeat)
    clearInterval(expire)
    await maintenance
    const service = current
    current = undefined
    await service?.stop()
    await expiry
    releaseLease(ENGINE_LEASE, owner, db)
  }
}
