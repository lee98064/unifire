import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuleInput } from '../../shared/schemas/automation'
import { createDatabase } from '../../server/db'
import { auditEvents, infraDevices } from '../../server/db/schema'
import { MINUTE } from '../../server/engine/access-time'
import { createInfra } from '../../server/engine/infra'
import { createDeviceSampler } from '../../server/engine/infra/device-sampler'
import { createManagedRoutes } from '../../server/engine/managed-routes'
import { createNotifier } from '../../server/engine/notifiers'
import { createRules } from '../../server/engine/rules'
import { createWatchdogs } from '../../server/engine/watchdogs'
import { createWol } from '../../server/engine/wol'
import { createAccess } from '../../server/services/access'
import { createControllerService, systemContext, type ControllerService } from '../../server/services/controller'
import { Device } from '../../server/unifi/endpoints/schemas'
import { AP1, AP2, GATEWAY_MAC, SWITCH_MAC } from '../../server/unifi/mock/infra'
import { initializeCrypto } from '../../server/utils/crypto'

describe('WP8 device commands and infra rules with a fake UniFi controller', () => {
  let database: ReturnType<typeof createDatabase>
  let service: ControllerService
  let time: number
  const stops: (() => Promise<unknown>)[] = []

  beforeEach(async () => {
    time = Date.now()
    database = createDatabase()
    initializeCrypto(Buffer.alloc(32, 8))
    service = await createControllerService(database.db, { mock: true })
    await service.ready()
  })

  afterEach(async () => {
    await Promise.allSettled(stops.splice(0).reverse().map(stop => stop()))
    await service?.stop()
    database?.sqlite.close()
  })

  function actions(infra?: ReturnType<typeof createInfra>) {
    const { db } = database
    const access = createAccess(db, service)
    const notifications = createNotifier(db, access, { mock: true })
    return { access, managed: createManagedRoutes(db, service), notifications, infra,
      watchdogs: createWatchdogs(db, service, notifications.notify), wol: createWol(db, service) }
  }

  function locateUntil() {
    return database.db.select().from(infraDevices).where(eq(infraDevices.mac, AP1)).get()?.locateUntil
  }

  it('audits locate and restart, honours dry-run, and unsets an expired LED on engine startup', async () => {
    const infra = createInfra(database.db, service, { now: () => time })
    const stop = infra.start(() => true)
    stops.push(stop)
    await infra.locate(AP1, { on: true, minutes: 1 }, { ...systemContext, dryRun: true })
    expect(locateUntil()).toBeNull()
    await infra.locate(AP1, { on: true, minutes: 1 }, systemContext)
    expect(infra.get(AP1).locating).toBe(true)
    expect(locateUntil()).toBe(time + MINUTE)
    const api = service.runtime!.api
    expect((await api.devices()).find(device => device.mac === AP1)?.locating).toBe(true)

    await expect(infra.restart(GATEWAY_MAC, false, systemContext)).rejects.toMatchObject({ code: 'GATEWAY_CONFIRMATION_REQUIRED' })
    await expect(infra.restart(AP2, false, { ...systemContext, dryRun: true })).resolves.toEqual({ ok: true })
    expect(service.runtime!.ledger.explainsDeviceReboot(AP2)).toBe(false)
    await infra.restart(AP2, false, systemContext)
    expect(service.runtime!.ledger.explainsDeviceReboot(AP2)).toBe(true)
    await service.runtime!.writes.deviceAction({ cmd: 'power-cycle', mac: SWITCH_MAC, port_idx: 13 }, systemContext)
    expect(service.runtime!.ledger.explainsDeviceReboot(AP1)).toBe(true)

    await stop()
    time += MINUTE + 1
    const rebooted = createInfra(database.db, service, { now: () => time })
    stops.push(rebooted.start(() => true))
    await rebooted.expire()
    expect(locateUntil()).toBeNull()
    expect(rebooted.get(AP1).locating).toBe(false)
    expect((await api.devices()).find(device => device.mac === AP1)?.locating).toBe(false)
    expect(database.db.select().from(auditEvents).where(eq(auditEvents.category, 'device')).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'device.set-locate', dryRun: true }),
      expect.objectContaining({ action: 'device.set-locate', dryRun: false }),
      expect.objectContaining({ action: 'device.unset-locate', dryRun: false }),
      expect.objectContaining({ action: 'device.restart', severity: 'error' }),
      expect.objectContaining({ action: 'device.restart', severity: 'success' }),
    ]))
  })

  it('fires an offline rule once per matching outage and cancels a delay on recovery', async () => {
    const { db } = database
    const { scope } = service.runtime!
    const sampler = createDeviceSampler(db, { emit: event => service.engine.emit('event', event), changed: () => {} })
    const run = createRules(db, service, actions(), { now: () => time })
    const stop = run.start(() => true)
    stops.push(stop)
    const makeRule = (minutes: number, mac: string | null) => run.create(RuleInput.parse({
      name: `Offline ${minutes}`, enabled: true, trigger: { type: 'infra.offline', mac, minutes }, description: null,
      conditions: [], actions: [{ type: 'notify', title: '{{device}} {{downtime}}' }], cooldownSeconds: 0,
    }))
    const immediate = makeRule(0, AP1)
    const delayed = makeRule(2, null)
    const count = (id: string) => run.page({ limit: 10, ruleId: id }).items.length
    const reading = (mac: string, state: number) => Device.parse({ mac, state, name: 'Test AP', model: 'U7PRO', type: 'uap' })
    const report = (state1: number, state2: number) => sampler.sample([reading(AP1, state1), reading(AP2, state2)], 'default', scope, time)

    report(1, 1)
    time += MINUTE
    report(0, 1)
    await expect.poll(() => count(immediate.id)).toBe(1)
    time += MINUTE
    report(1, 1)
    time += 2 * MINUTE
    await run.dispatch({ type: 'infra.offline', mac: AP1 })
    expect(count(delayed.id)).toBe(0)

    report(0, 0)
    time += 2 * MINUTE
    await run.dispatch({ type: 'infra.offline', mac: AP1 })
    expect(count(immediate.id)).toBe(2)
    expect(count(delayed.id)).toBe(2)
    expect(run.page({ limit: 10, ruleId: delayed.id }).items.map(row => row.event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ mac: AP1, downtime: 120, device: 'Test AP', model: 'U7PRO' }),
      expect.objectContaining({ mac: AP2, downtime: 120 }),
    ]))
    await stop()
    const restored = createRules(db, service, actions(), { now: () => time })
    stops.push(restored.start(() => true))
    await restored.dispatch({ type: 'infra.offline', mac: AP1 })
    expect(restored.page({ limit: 10, ruleId: delayed.id }).items).toHaveLength(2)
  })

  it('uses per-rule temperature thresholds, filters expected reboots, and previews future rule blocks', async () => {
    const { db } = database
    const infra = createInfra(db, service, { now: () => time })
    const rules = createRules(db, service, actions(infra), { now: () => time })
    stops.push(infra.start(() => true), rules.start(() => true))
    const rule = (trigger: unknown, actions: unknown[], conditions: unknown[] = []) => rules.create(RuleInput.parse({
      name: 'Infra test', description: null, enabled: true, cooldownSeconds: 0, trigger, actions, conditions,
    }))
    const locate = { type: 'device.locate', mac: AP1, minutes: 5 }
    const overheat = rule({ type: 'infra.overheat', celsius: 65 }, [locate])
    const reboot = rule({ type: 'infra.rebooted' }, [{ type: 'notify', title: '{{device}}' }])
    const shipLater = rule({ type: 'port.issue' }, [locate])
    const actionLater = rule({ type: 'infra.firmware' }, [{ type: 'poe.set', switchMac: SWITCH_MAC, portIdx: 13, on: false }])
    const conditionLater = rule({ type: 'infra.online' }, [locate], [{ type: 'person.room', personId: 'p', roomId: 'r', inRoom: true }])
    const count = (id: string) => rules.page({ limit: 10, ruleId: id }).items.length

    for (const tempC of [64, 65, 63, 67, 62, 68]) service.engine.emit('event', { type: 'infra.temperature', mac: AP1, tempC })
    await expect.poll(() => count(overheat.id)).toBe(2)
    expect(infra.get(AP1).locating).toBe(true)
    expect(await rules.dispatch({ type: 'infra.rebooted', mac: AP1, unexpected: false })).toEqual([])
    await rules.dispatch({ type: 'infra.rebooted', mac: AP1, unexpected: true })
    expect(count(reboot.id)).toBe(1)
    expect(await rules.dispatch({ type: 'port.issue' })).toEqual([])
    for (const implemented of [shipLater, actionLater]) {
      expect(await rules.test(implemented.id, true)).toMatchObject({
        test: true, ok: true, results: [expect.objectContaining({ message: 'rule.result.would' })],
      })
    }
    expect(await rules.test(conditionLater.id, true)).toMatchObject({
      test: true, ok: false, results: [expect.objectContaining({ message: 'rule.result.not_implemented' })],
    })
    const synthetic = await rules.test(overheat.id, true)
    expect(synthetic.event).toMatchObject({ synthetic: true, temp: 65, mac: expect.any(String), model: expect.any(String) })
  })
})
