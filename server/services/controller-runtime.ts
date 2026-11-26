import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { createAuditWatch } from '../engine/audit-watch'
import { createSnapshots } from '../engine/snapshots'
import { createRouting } from '../engine'
import { UnifiError } from '../unifi/errors'
import { createControllerService, type ControllerService } from './controller'
import { createAccess } from './access'
import { acquireLease, ENGINE_LEASE, releaseLease, renewLease } from './lease'

let access: ReturnType<typeof createAccess> | undefined
let current: ControllerService | undefined
let routing: ReturnType<typeof createRouting> | undefined
let snapshots: ReturnType<typeof createSnapshots> | undefined
let snapshotsReady: Promise<void> | undefined
let starting: Promise<() => Promise<void>> | undefined

export async function useController() {
  if (!current) await starting
  if (!current) throw new UnifiError('UNIFI_INACTIVE')
  return current
}

export async function useAccess() {
  const service = await useController()
  await service.ready()
  if (!access) throw new UnifiError('UNIFI_INACTIVE')
  return access
}

export async function useRouting() {
  const service = await useController()
  await service.ready()
  if (!routing) throw new UnifiError('UNIFI_INACTIVE')
  return routing
}

export async function useSnapshots() {
  await useController()
  await snapshotsReady
  if (!snapshots) throw new UnifiError('UNIFI_INACTIVE')
  return snapshots
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
  let stopInsights: (() => Promise<unknown>) | undefined
  let stopRouting: (() => Promise<void>) | undefined
  let stopAccess: (() => Promise<void>) | undefined

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
      routing = undefined
      access = undefined
      snapshots = undefined
      snapshotsReady = undefined
      expiresAt = 0
      await stopRouting?.()
      await stopAccess?.()
      await stopInsights?.()
      await stale.stop()
    }
    if (stopping || !acquireLease(ENGINE_LEASE, owner, TTL, db, now)) return
    expiresAt = now + TTL
    try {
      current = await createControllerService(db, { mock, lively, active: () => Date.now() < expiresAt })
      snapshots = createSnapshots(db, current)
      const snapshotJob = snapshots.start()
      snapshotsReady = snapshotJob.ready.catch(() => {})
      const stopWatch = createAuditWatch(db, current).start()
      stopInsights = () => Promise.allSettled([snapshotJob.stop(), stopWatch()])
      routing = createRouting(db, current)
      stopRouting = routing.start()
      access = createAccess(db, current)
      stopAccess = access.start(() => Date.now() < expiresAt)
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
  return async () => {
    stopping = true
    clearInterval(heartbeat)
    await maintenance
    const service = current
    access = undefined
    current = undefined
    routing = undefined
    snapshots = undefined
    snapshotsReady = undefined
    await stopRouting?.()
    await stopAccess?.()
    await stopInsights?.()
    await service?.stop()
    releaseLease(ENGINE_LEASE, owner, db)
  }
}
