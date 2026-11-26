import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../../server/db'
import { clients, controller, egresses, egressIpChecks, egressSamples, people, personDevices } from '../../server/db/schema'
import { compactSamples } from '../../server/engine/probes/health'
import { ispReport } from '../../server/engine/reports/isp'
import { usageReport } from '../../server/engine/reports/usage'
import { createUsageStore } from '../../server/engine/samplers/usage'
import { forwardedOrigin } from '../../server/utils/proxy-origin'
import { parseSpeedtest } from '../../server/unifi/speedtest'
import { gatewayRates, wanRates, wanTelemetry } from '../../server/unifi/wan'
import { Device } from '../../server/unifi/endpoints/schemas'

let database: ReturnType<typeof createDatabase>
beforeEach(() => { database = createDatabase() })
afterEach(() => { database.sqlite.close() })

describe('WP7 reports', () => {
  it('preserves exact samples after chart compaction and excludes gaps from monthly uptime', () => {
    const { db } = database
    const from = Date.parse('2026-10-31T16:00:00Z') // November 1 in Taipei
    const interval = 30_000
    db.insert(controller).values({ id: 1, url: 'mock://unifire', username: 'mock', encryptedPassword: 'fixture', verifyMode: 'insecure' }).run()
    db.insert(egresses).values({ id: 'wan', name: 'WAN', kind: 'wan', wanGroup: 'WAN', color: '#006fff' }).run()
    const samples: Omit<typeof egressSamples.$inferInsert, 'egressId' | 'intervalMs'>[] = [
      { ts: from - interval, status: 'down', source: 'unifi' },
      { ts: from, status: 'down', source: 'unifi' },
      { ts: from + interval, status: 'healthy', latencyMs: 10, lossPct: 0 },
      { ts: from + 2 * interval, status: 'degraded', latencyMs: 30, lossPct: 25 },
      { ts: from + 3 * interval, status: 'unknown' },
      { ts: from + 10 * interval, status: 'down', lossPct: 100 },
      { ts: from + 20 * interval, status: 'healthy', latencyMs: 20, lossPct: 0 },
    ]
    db.insert(egressSamples).values(samples.map(row => ({ egressId: 'wan', intervalMs: interval, ...row }))).run()
    db.insert(egressIpChecks).values([0, 5, 10].map((steps, index) => ({
      egressId: 'wan', ts: from + steps * interval, ip: index === 1 ? '198.51.100.2' : '198.51.100.1',
    }))).run()
    const at = Date.parse('2026-12-08T00:00:00Z')
    const read = () => ispReport(db, '2026-11', 'Asia/Taipei', 'default', undefined, interval, at)
    const before = read()
    compactSamples(db, at)
    expect(db.select().from(egressSamples).all()).toHaveLength(0)
    expect(read()).toEqual(before)
    expect(before.wans[0]).toMatchObject({
      uptimePct: 60, latencyP50: 20, latencyP95: 30, lossPct: 31.25,
      outages: [
        { start: from, end: from + interval, durationSec: 30 },
        { start: from + 10 * interval, end: from + 11 * interval, durationSec: 30 },
      ],
      publicIps: [{ ip: '198.51.100.1', firstSeen: from, lastSeen: from + 10 * interval },
        { ip: '198.51.100.2', firstSeen: from + 5 * interval, lastSeen: from + 5 * interval }],
    })
    expect(before.wans[0]?.daily.slice(0, 2)).toEqual([
      { date: '2026-11-01', uptimePct: 60, latencyP50: 20 },
      { date: '2026-11-02', uptimePct: null, latencyP50: null },
    ])
  })

  it('rolls up both occurrences of a local hour and counts overlap once per person after pruning minutes', () => {
    const { db } = database
    const timezone = 'America/New_York'
    const a = '00:11:22:33:44:55'
    const b = '00:11:22:33:44:66'
    db.insert(people).values({ id: 'p', name: 'Person', avatar: 'P', color: '#123456', createdAt: 0 }).run()
    db.insert(clients).values([{ mac: a, alias: 'First' }, { mac: b, hostname: 'second' }]).run()
    db.insert(personDevices).values([{ mac: a, personId: 'p' }, { mac: b, personId: 'p' }]).run()
    const first = Date.parse('2026-11-01T05:15:00Z')
    const second = Date.parse('2026-11-01T06:15:00Z')
    const at = Date.parse('2026-12-01T06:00:00Z')
    const store = createUsageStore(db)
    store.record([{ mac: a, ts: first, rxBytes: 100, txBytes: 20, active: true },
      { mac: b, ts: first, rxBytes: 200, txBytes: 30, active: true },
      { mac: b, ts: second, rxBytes: 300, txBytes: 40, active: true }], timezone)
    store.prune(at, 14)
    const report = usageReport(db, 'month', '2026-11', timezone, at)
    expect(report.from).toBe(Date.parse('2026-11-01T04:00:00Z'))
    expect(report.to).toBe(Date.parse('2026-12-01T05:00:00Z'))
    expect(report.totals).toEqual({ rxBytes: 600, txBytes: 90 })
    expect(report.daily[0]).toEqual({ date: '2026-11-01', rxBytes: 600, txBytes: 90 })
    expect(report.people).toEqual([{ personId: 'p', name: 'Person', bytes: 690, activeMinutes: 2 }])
    expect(report.topClients.map(({ name, activeMinutes, personId }) => [name, activeMinutes, personId]))
      .toEqual([['second', 2, 'p'], ['First', 1, 'p']])
    expect(report.heatmap[6]?.[1]).toBe(690)
  })

  it('decodes historical and widget speedtest results without treating placeholders as measurements', () => {
    expect(parseSpeedtest({ speed_test: { data: [] } }).available).toBe(true)
    expect(parseSpeedtest([])).toEqual({ available: false, running: false, results: [] })
    expect(parseSpeedtest([{ status: 'running', xput_download: 0, xput_upload: 0 }]))
      .toEqual({ available: true, running: true, results: [] })
    expect(parseSpeedtest({ speed_test: { data: [{ time: 1_800_000_000, wan: 'WAN2', download_mbps: 426.2, upload_mbps: 80, latency_ms: 7 }] } }))
      .toEqual({ available: true, running: false, results: [{ ts: 1_800_000_000_000, wan: 'WAN2', downMbps: 426.2, upMbps: 80, latencyMs: 7 }] })
  })

  it('matches WAN uplink rates and rejects forwarded hosts with path, credentials or a proxy chain', () => {
    const gateway = Device.parse({ mac: '00:11:22:33:44:55', type: 'udm', wan1: { ifname: 'eth8' }, wan2: { ifname: 'eth9' },
      uplink_table: [{ name: 'eth8', 'rx_bytes-r': 100, 'tx_bytes-r': 50 }, { name: 'eth9', 'rx_bytes-r': '75', 'tx_bytes-r': '25' }] })
    expect(wanRates(wanTelemetry(gateway, 'WAN2'))).toEqual({ rxBps: 600, txBps: 200 })
    expect(gatewayRates(gateway, ['WAN', 'WAN2'])).toEqual({ rxBps: 1400, txBps: 600 })
    expect(forwardedOrigin('https', 'unifire.example.test:8443')).toBe('https://unifire.example.test:8443')
    for (const host of ['user@example.test', 'example.test/route', 'good.test, bad.test']) {
      expect(forwardedOrigin('https', host)).toBeUndefined()
    }
  })
})
