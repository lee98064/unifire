import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../../server/db'
import { clients, energyHourly, poeOffLog, portEvents, portPeers, portState } from '../../server/db/schema'
import { DAY, HOUR, MINUTE } from '../../server/engine/access-time'
import { energyPeriod, energyReport, observePortEnergy } from '../../server/engine/infra/energy'
import { createPortHealth } from '../../server/engine/infra/port-health'
import { ackPortEvents, listPortEvents, updatePortEvent } from '../../server/engine/infra/port-history'
import { createControllerService, type ControllerService } from '../../server/services/controller'
import { createSettingsService } from '../../server/services/settings'
import { Device } from '../../server/unifi/endpoints/schemas'
import { AP2, SWITCH_MAC } from '../../server/unifi/mock/infra'
import { initializeCrypto } from '../../server/utils/crypto'

const FIRST = Date.UTC(2026, 10, 22, 16)
const CLIENT_A = '02:01:00:00:00:01'
const CLIENT_B = '02:01:00:00:00:02'
const CLIENT_C = '02:01:00:00:00:03'

describe('WP9 port health and energy', () => {
  let database: ReturnType<typeof createDatabase>
  let service: ControllerService
  let health: ReturnType<typeof createPortHealth>

  beforeEach(async () => {
    initializeCrypto(Buffer.alloc(32, 9))
    database = createDatabase()
    service = await createControllerService(database.db, { mock: true })
    await service.ready()
    health = createPortHealth(database.db, service)
  })
  afterEach(async () => {
    await service?.stop()
    database.sqlite.close()
  })

  const scope = () => service.runtime!.scope
  const key = () => ({ scope: scope(), switchMac: SWITCH_MAC, portIdx: 1 })
  function poll(at: number, fields: Record<string, unknown> = {}) {
    const dev = Device.parse({ mac: SWITCH_MAC, state: 1, adopted: true, type: 'usw', name: 'Test switch',
      port_table: [{ port_idx: 1, name: 'Port 1', up: true, speed: 1000, mac_table_count: 1,
        last_connection: { mac: CLIENT_A, connected: true }, ...fields }] })
    health.sample([dev], [], scope(), at, observePortEnergy)
  }
  const eventKinds = () => database.db.select().from(portEvents).orderBy(portEvents.ts).all().map(row => row.kind)

  it('keeps a per-peer baseline across sampler restart, recovers, and expires the old high speed', () => {
    poll(FIRST)
    poll(FIRST + MINUTE, { speed: 100 })
    health = createPortHealth(database.db, service)
    poll(FIRST + 2 * MINUTE, { speed: 100 })
    poll(FIRST + 3 * MINUTE, { speed: 100 })
    expect(eventKinds()).toEqual(['downgrade'])
    poll(FIRST + 4 * MINUTE)
    expect(eventKinds()).toEqual(['downgrade', 'recovered'])
    poll(FIRST + 5 * MINUTE, { speed: 100, last_connection: { mac: CLIENT_B } })
    poll(FIRST + 6 * MINUTE, { speed: 100, last_connection: { mac: CLIENT_B } })
    expect(database.db.select().from(portState).get()?.baselineSpeed).toBe(100)
    poll(FIRST + 30 * DAY + HOUR, { speed: 100 })
    expect(database.db.select().from(portState).get()?.baselineSpeed).toBe(100)
    expect(eventKinds()).toEqual(['downgrade', 'recovered'])
    expect(database.db.select().from(portPeers).all().map(row => row.maxSpeed).sort((a, b) => a! - b!)).toEqual([100, 1000])
  })

  it('ignores a reset and the absolute error floor and detects flaps from native and observed counts', () => {
    const settings = createSettingsService(database.db)
    settings.patch({ infra: { ...settings.get().infra, flapsPerHour: 2 } })
    const counters = (errors: number, packets: number, native?: number) => ({ rx_errors: errors,
      tx_errors: 0, rx_packets: packets, tx_packets: 0, link_down_count: native })
    poll(FIRST, counters(1000, 10_000, 20))
    poll(FIRST + MINUTE, counters(1049, 10_050, 21))
    expect(eventKinds()).toEqual([])
    poll(FIRST + 2 * MINUTE, counters(3, 20, 0))
    expect(eventKinds()).toEqual([])
    poll(FIRST + 3 * MINUTE, counters(55, 1000, 1))
    expect(eventKinds()).toEqual(['errors', 'flapping'])
    poll(FIRST + HOUR + 5 * MINUTE, { ...counters(110, 1800), up: false })
    poll(FIRST + HOUR + 6 * MINUTE, counters(112, 1840))
    poll(FIRST + HOUR + 7 * MINUTE, { ...counters(123, 1900), up: false })
    expect(eventKinds()).toEqual(['errors', 'flapping', 'flapping'])
  })

  it('learns quietly, distinguishes approved peers, honors ignored ports and paginates acknowledgements', () => {
    poll(FIRST)
    poll(FIRST + MINUTE, { last_connection: { mac: CLIENT_B } })
    expect(eventKinds()).toEqual([])
    database.db.insert(clients).values({ mac: CLIENT_C, approval: 'approved' }).run()
    poll(FIRST + DAY, { last_connection: { mac: CLIENT_C } })
    const stranger = '02:01:00:00:00:04'
    poll(FIRST + DAY + MINUTE, { last_connection: { mac: stranger } })
    const settings = createSettingsService(database.db)
    settings.patch({ infra: { ...settings.get().infra, ignoredPorts: [{ switchMac: SWITCH_MAC, portIdx: 1 }] } })
    poll(FIRST + DAY + 2 * MINUTE, { last_connection: { mac: '02:01:00:00:00:05' } })
    expect(eventKinds()).toEqual(['peer_changed', 'new_device'])
    const page = listPortEvents(database.db, scope(), { limit: 1, unacknowledged: true, portIdx: 1 })
    expect(page.items[0]?.kind).toBe('new_device')
    expect(listPortEvents(database.db, scope(), { limit: 1, cursor: page.nextCursor! }).items[0]?.kind).toBe('peer_changed')
    expect(updatePortEvent(database.db, scope(), page.items[0]!.id, true).acknowledged).toBe(true)
    expect(ackPortEvents(database.db, scope(), SWITCH_MAC).count).toBe(1)
    expect(listPortEvents(database.db, scope(), { limit: 10, unacknowledged: true }).items).toEqual([])
  })

  it('uses mock scenario observations to generate downgrade, recovery, error, flap and new-peer events', async () => {
    const runtime = service.runtime!
    async function sample(at: number) {
      const [devices, stations] = await Promise.all([runtime.api.devices(), runtime.api.activeClients()])
      health.sample(devices, stations, scope(), at, observePortEnergy)
    }
    await sample(FIRST)
    service.mockScenario!('downgrade-port')
    await sample(FIRST + MINUTE)
    await sample(FIRST + 2 * MINUTE)
    service.mockScenario!('recover')
    await sample(FIRST + 3 * MINUTE)
    service.mockScenario!('port-errors')
    await sample(FIRST + 4 * MINUTE)
    service.mockScenario!('flap-port')
    await sample(FIRST + 5 * MINUTE)
    service.mockScenario!('new-device')
    await sample(FIRST + DAY)
    expect(eventKinds()).toEqual(expect.arrayContaining(['downgrade', 'recovered', 'errors', 'flapping', 'new_device']))
  })

  it('splits UTC energy at hour boundaries, skips long gaps, and reports Taipei periods and measured savings', () => {
    const settings = createSettingsService(database.db)
    settings.patch({ energy: { ratePerKwh: 5, currency: 'TWD' } })
    const powered = (at: number, watts: string) => poll(at, {
      port_poe: true, poe_mode: 'auto', poe_power: watts, last_connection: { mac: AP2 },
    })
    powered(FIRST - MINUTE, '12.00')
    powered(FIRST + MINUTE, '12.00')
    powered(FIRST + 6 * MINUTE, '48.00')
    powered(FIRST + 7 * MINUTE, '12.00')
    const { db } = database
    const rows = db.select().from(energyHourly).where(and(eq(energyHourly.scope, scope()), eq(energyHourly.portIdx, 1)))
      .orderBy(energyHourly.hourTs).all()
    expect(rows.map(row => [row.hourTs, row.wh, row.sampledMs]))
      .toEqual([[FIRST - HOUR, 0.2, MINUTE], [FIRST, 0.4, 2 * MINUTE]])
    db.insert(poeOffLog).values({ ...key(), start: FIRST - HOUR, end: FIRST + HOUR, scheduleId: 'schedule', scheduleName: 'AP sleep', avgW: 12 }).run()
    const report = energyReport(db, service, 'day', FIRST, FIRST + 2 * HOUR)
    expect(report).toMatchObject({ from: FIRST, to: FIRST + DAY, timezone: 'Asia/Taipei', totalWh: 0.4, previousTotalWh: 0.2,
      savings: [{ scheduleId: 'schedule', wh: 12, cost: 0.06 }] })
    expect(report.series[0]).toEqual({ ts: FIRST, byDevice: { [SWITCH_MAC]: 0.4 } })
    expect(report.coverage).toBeCloseTo(1 / 60)
    expect(energyPeriod('week', FIRST, 'Asia/Taipei').boundaries).toHaveLength(8)
    expect(energyPeriod('year', FIRST, 'Asia/Taipei').boundaries).toHaveLength(13)
    expect(energyPeriod('day', Date.UTC(2026, 10, 1, 12), 'America/New_York').boundaries).toHaveLength(26)
  })
})
