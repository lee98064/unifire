import { and, avg, count, desc, eq, gte, lt, lte, sql } from 'drizzle-orm'
import { DeviceEvents, DeviceSeries, type SeriesRangeT } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { deviceRollupsHourly, deviceSamples, deviceTransitions, firmwareHistory, infraDevices } from '../../db/schema'
import { portEventHistory } from './port-history'
import { DAY, HOUR, MINUTE } from '../access-time'

const rollupBucket = sql<number>`cast(${deviceSamples.ts} / ${HOUR} as integer) * ${HOUR}`
const online = sql<number>`case when ${deviceSamples.state} = 'online' then 1.0 else 0.0 end`

export function archiveDeviceSamples(db: Pick<Db, 'run' | 'delete'>, from: number, at: number,
  retention: { retainRawDays: number, retainRollupDays: number }) {
  const hour = Math.floor(at / HOUR) * HOUR
  db.run(sql`
    insert into device_rollups_hourly (mac, hour_ts, online_fraction,
      cpu_avg, cpu_max, mem_avg, mem_max, temp_avg, temp_max, clients_avg, clients_max,
      rx_avg, rx_max, tx_avg, tx_max, poe_w_avg)
    select mac, ${rollupBucket}, avg(${online}),
      avg(cpu), max(cpu), avg(mem), max(mem), avg(temp), max(temp), avg(clients), max(clients),
      avg(rx_bps), max(rx_bps), avg(tx_bps), max(tx_bps), avg(poe_w)
    from ${deviceSamples}
    where ts >= ${from} and ts < ${hour}
    group by mac, 2
    on conflict(mac, hour_ts) do nothing
  `)
  db.delete(deviceSamples).where(lt(deviceSamples.ts, at - retention.retainRawDays * DAY)).run()
  db.delete(deviceRollupsHourly).where(lt(deviceRollupsHourly.hourTs, hour - retention.retainRollupDays * DAY)).run()
}

export function availabilityByDevice(db: Db, scope: string, at: number) {
  const rows = db.select({ mac: deviceSamples.mac, sampled: count(), online: avg(online) })
    .from(deviceSamples).innerJoin(infraDevices, eq(deviceSamples.mac, infraDevices.mac))
    .where(and(eq(infraDevices.scope, scope), gte(deviceSamples.ts, Math.floor(at / MINUTE) * MINUTE - DAY + MINUTE),
      lte(deviceSamples.ts, at))).groupBy(deviceSamples.mac).all()
  return new Map(rows.map(row => [row.mac, row.sampled < 60 || row.online === null ? null : Number(row.online)]))
}

const ranges = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY }

export function deviceSeries(db: Db, mac: string, range: SeriesRangeT, at: number) {
  const bucket = range === '24h' ? 5 * MINUTE : range === '7d' ? HOUR : 6 * HOUR
  const from = at - ranges[range]
  const currentHour = Math.floor(at / HOUR) * HOUR
  const rolledFrom = Math.floor(from / HOUR) * HOUR
  const rawBucket = range === '24h' ? bucket : HOUR
  const raw = db.select({
    ts: sql<number>`cast(${deviceSamples.ts} / ${rawBucket} as integer) * ${rawBucket}`,
    online: avg(online).mapWith(Number), cpuPct: avg(deviceSamples.cpu).mapWith(Number),
    memPct: avg(deviceSamples.mem).mapWith(Number), tempC: avg(deviceSamples.temp).mapWith(Number),
    clients: avg(deviceSamples.clients).mapWith(Number), rxBps: avg(deviceSamples.rxBps).mapWith(Number),
    txBps: avg(deviceSamples.txBps).mapWith(Number), poeW: avg(deviceSamples.poeW).mapWith(Number),
  }).from(deviceSamples).where(and(eq(deviceSamples.mac, mac),
    gte(deviceSamples.ts, range === '24h' ? from : currentHour), lte(deviceSamples.ts, at))).groupBy(sql`1`).orderBy(sql`1`).all()

  if (range === '24h') return DeviceSeries.parse({ mac, range, bucketSec: bucket / 1000, points: raw })
  const hourly = db.select({
    ts: deviceRollupsHourly.hourTs, online: deviceRollupsHourly.onlineFraction, cpuPct: deviceRollupsHourly.cpuAvg,
    memPct: deviceRollupsHourly.memAvg, tempC: deviceRollupsHourly.tempAvg, clients: deviceRollupsHourly.clientsAvg,
    rxBps: deviceRollupsHourly.rxAvg, txBps: deviceRollupsHourly.txAvg, poeW: deviceRollupsHourly.poeWAvg,
  }).from(deviceRollupsHourly).where(and(eq(deviceRollupsHourly.mac, mac),
    gte(deviceRollupsHourly.hourTs, rolledFrom), lt(deviceRollupsHourly.hourTs, currentHour)))
    .orderBy(deviceRollupsHourly.hourTs).all()
  const points = [...hourly, ...raw]
  if (bucket === HOUR) return DeviceSeries.parse({ mac, range, bucketSec: bucket / 1000, points })

  const groups = new Map<number, typeof points>()
  for (const point of points) {
    const ts = Math.floor(point.ts / bucket) * bucket
    const group = groups.get(ts) ?? []
    group.push(point)
    groups.set(ts, group)
  }
  return DeviceSeries.parse({ mac, range, bucketSec: bucket / 1000, points: [...groups].map(([ts, group]) => {
    const mean = (key: Exclude<keyof typeof points[number], 'ts'>) => {
      const sampled = group.flatMap(point => point[key] ?? [])
      return sampled.length ? sampled.reduce((total, value) => total + value, 0) / sampled.length : null
    }
    return { ts, online: mean('online'), cpuPct: mean('cpuPct'), memPct: mean('memPct'), tempC: mean('tempC'),
      clients: mean('clients'), rxBps: mean('rxBps'), txBps: mean('txBps'), poeW: mean('poeW') }
  }) })
}

export function deviceEvents(db: Db, mac: string, from?: number, to?: number, limit?: number) {
  const transitions = db.select().from(deviceTransitions).where(and(eq(deviceTransitions.mac, mac),
    from === undefined ? undefined : gte(deviceTransitions.ts, from), to === undefined ? undefined : lte(deviceTransitions.ts, to)))
    .orderBy(desc(deviceTransitions.ts), desc(deviceTransitions.id))
  const firmware = db.select().from(firmwareHistory).where(and(eq(firmwareHistory.mac, mac),
    from === undefined ? undefined : gte(firmwareHistory.ts, from), to === undefined ? undefined : lte(firmwareHistory.ts, to)))
    .orderBy(desc(firmwareHistory.ts), desc(firmwareHistory.id))
  const scope = db.select({ scope: infraDevices.scope }).from(infraDevices).where(eq(infraDevices.mac, mac)).get()?.scope ?? ''
  return DeviceEvents.parse({ transitions: (limit ? transitions.limit(limit) : transitions).all(),
    firmware: (limit ? firmware.limit(limit) : firmware).all(), portEvents: portEventHistory(db, scope, mac, undefined, from, to, limit) })
}
