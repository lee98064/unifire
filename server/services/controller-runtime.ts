import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { createAutomation } from '../engine/automation'
import { createAuditWatch } from '../engine/audit-watch'
import { createSpeedtests } from '../engine/reports/speedtest'
import { createSnapshots } from '../engine/snapshots'
import { createInfra } from '../engine/infra'
import { createRouting } from '../engine'
import { UnifiError } from '../unifi/errors'
import { apiError } from '../utils/api-error'
import { createInventory } from './inventory'
import { createControllerService, type ControllerService } from './controller'
import { createAccess } from './access'
import { seedMockAutomation } from './seed-automation'
import { acquireLease, ENGINE_LEASE, releaseLease, renewLease } from './lease'

let infra: ReturnType<typeof createInfra> | undefined
let speedtests: ReturnType<typeof createSpeedtests> | undefined
let automation: ReturnType<typeof createAutomation> | undefined
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

export const cachedControllerStatus = () => current?.connectivity()

export async function useInfra() {
  if (!infra) await starting
  const service = await useController()
  await service.ready()
  if (!infra || service !== current) throw new UnifiError('UNIFI_INACTIVE')
  return infra
}

export async function useSpeedtests() {
  await useController()
  if (!speedtests) throw apiError(503, 'UNIFI_INACTIVE', 'errors.unifiInactive')
  return speedtests
}

export async function useDashboard(db: Db) {
  const service = await useController()
  return createInventory(db, service, routing, access).dashboard()
}

export async function useAccess() {
  const service = await useController()
  await service.ready()
  if (!access) throw new UnifiError('UNIFI_INACTIVE')
  return access
}

export async function useAutomation() {
  if (!automation) await starting
  const service = current
  await service?.ready()
  if (!service || service !== current || !automation) throw apiError(503, 'UNIFI_INACTIVE', 'errors.unifiInactive')
  return automation
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

export function startControllerRuntime(db: Db, mock: boolean, lively: boolean, onError: () => void = () => {}) {
  starting = runControllerRuntime(db, mock, lively, onError)
  return starting
}

async function runControllerRuntime(db: Db, mock: boolean, lively: boolean, onError: () => void) {
  const owner = randomUUID()
  let expiresAt = 0
  let stopping = false
  let maintenance: Promise<void> | undefined
  let stopInsights: (() => Promise<unknown>) | undefined
  let stopRouting: (() => Promise<void>) | undefined
  let stopAutomation: (() => Promise<void>) | undefined
  let stopInfra: (() => Promise<void>) | undefined
  let stopAccess: (() => Promise<void>) | undefined

  async function stopServices() {
    const service = current
    const reportWorker = speedtests
    infra = undefined
    current = undefined
    routing = undefined
    access = undefined
    snapshots = undefined
    snapshotsReady = undefined
    automation = undefined
    speedtests = undefined
    await Promise.allSettled([stopInfra?.(), stopAutomation?.(), stopRouting?.(), stopAccess?.(), stopInsights?.(), reportWorker?.stop()])
    stopInfra = undefined
    stopAutomation = stopRouting = stopAccess = stopInsights = undefined
    await service?.stop()
  }

  async function maintain() {
    if (stopping) return
    const now = Date.now()
    if (current && renewLease(ENGINE_LEASE, owner, TTL, db, now)) {
      expiresAt = now + TTL
      return
    }
    if (current) {
      expiresAt = 0
      await stopServices()
    }
    if (stopping || !acquireLease(ENGINE_LEASE, owner, TTL, db, now)) return
    expiresAt = now + TTL
    try {
      current = await createControllerService(db, { mock, lively, active: () => Date.now() < expiresAt })
      speedtests = createSpeedtests(db, current)
      snapshots = createSnapshots(db, current)
      const snapshotJob = snapshots.start()
      snapshotsReady = snapshotJob.ready.catch(() => {})
      const stopWatch = createAuditWatch(db, current).start()
      stopInsights = () => Promise.allSettled([snapshotJob.stop(), stopWatch()])
      routing = createRouting(db, current)
      stopRouting = routing.start()
      access = createAccess(db, current)
      const hasLease = () => Date.now() < expiresAt
      stopAccess = access.start(hasLease)
      if (mock) {
        await current.ready()
        seedMockAutomation(db)
      }
      infra = createInfra(db, current)
      automation = createAutomation(db, current, access, routing.managed, infra)
      stopAutomation = automation.start(hasLease)
      stopInfra = infra.start(hasLease)
    } catch (error) {
      expiresAt = 0
      try { await stopServices() } finally { releaseLease(ENGINE_LEASE, owner, db) }
      throw error
    }
  }

  await maintain().catch(onError)
  const heartbeat = setInterval(() => {
    if (maintenance) return
    maintenance = maintain().catch(onError).finally(() => { maintenance = undefined })
  }, 10_000)
  heartbeat.unref()
  return async () => {
    stopping = true
    clearInterval(heartbeat)
    await maintenance
    try { await stopServices() } finally { releaseLease(ENGINE_LEASE, owner, db) }
  }
}
