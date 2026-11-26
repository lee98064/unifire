import { and, asc, eq, gte, lt, sql } from 'drizzle-orm'
import { UsageReport, type UsageReportT } from '#shared/schemas/insight'
import type { Db } from '../../db'
import { clients, people, personDevices, usageQuarters } from '../../db/schema'
import { DAY, localEpoch, weekday, zonedInstant } from '../access-time'
import { countBits } from '../samplers/usage'
import { reportDays, usagePeriod } from './period'

type Client = UsageReportT['topClients'][number]
type Person = UsageReportT['people'][number]
const emptyBytes = () => ({ rxBytes: 0, txBytes: 0 })

export function usageReport(db: Db, range: '7d' | '30d' | 'month', month: string | undefined, timezone: string,
  now = Date.now()): UsageReportT {
  const period = usagePeriod(range, month, now, timezone)
  const from = Math.max(0, zonedInstant(period.from, timezone))
  const to = Math.max(from, Math.min(zonedInstant(period.to, timezone), now + 1))
  const days = reportDays(period.from, period.to, timezone)
  const daily = days.map(({ date }) => ({ date, ...emptyBytes() }))
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  const totals = emptyBytes()
  const roster = new Map(db.select({ personId: people.id, name: people.name }).from(people).all()
    .map(row => [row.personId, { ...row, bytes: 0, activeMinutes: 0 } satisfies Person]))
  const devices = new Map<string, Client>()
  const known = new Map(db.select({ mac: clients.mac, alias: clients.alias, hostname: clients.hostname, vendor: clients.vendor,
    personId: personDevices.personId }).from(clients).leftJoin(personDevices, eq(clients.mac, personDevices.mac)).all()
    .map(row => [row.mac, row]))
  const query = db.select().from(usageQuarters).where(and(gte(usageQuarters.ts, sql.placeholder('start')),
    lt(usageQuarters.ts, sql.placeholder('end')))).orderBy(asc(usageQuarters.ts)).prepare()
  function* quarters() {
    for (const [index, day] of days.entries()) {
      if (day.start >= to) break
      yield* query.all({ start: Math.max(from, day.start), end: Math.min(to, days[index + 1]?.start ?? to) })
    }
  }
  const activeByPerson = new Map<Person, number>()
  let quarter = -1
  let dayIndex = 0
  let weekdayIndex = 0
  let hour = 0
  function finishQuarter() {
    for (const [person, mask] of activeByPerson) person.activeMinutes += countBits(mask)
    activeByPerson.clear()
  }

  for (const row of quarters()) {
    if (quarter !== row.ts) {
      finishQuarter()
      quarter = row.ts
      const wall = localEpoch(quarter, timezone)
      dayIndex = Math.floor((wall - period.from) / DAY)
      weekdayIndex = weekday(wall)
      hour = new Date(wall).getUTCHours()
    }
    const day = daily[dayIndex]
    if (!day) continue
    const bytes = row.rxBytes + row.txBytes
    totals.rxBytes += row.rxBytes
    totals.txBytes += row.txBytes
    day.rxBytes += row.rxBytes
    day.txBytes += row.txBytes
    heatmap[weekdayIndex]![hour]! += bytes

    const identity = known.get(row.mac)
    const client = devices.get(row.mac) ?? { mac: row.mac, name: identity?.alias || identity?.hostname || identity?.vendor || row.mac,
      personId: identity?.personId ?? null, bytes: 0, activeMinutes: 0 }
    client.bytes += bytes
    client.activeMinutes += countBits(row.activeMask)
    devices.set(row.mac, client)
    const person = client.personId ? roster.get(client.personId) : undefined
    if (person) {
      person.bytes += bytes
      activeByPerson.set(person, (activeByPerson.get(person) ?? 0) | row.activeMask)
    }
  }
  finishQuarter()
  return UsageReport.parse({ from, to, totals, daily, heatmap,
    topClients: [...devices.values()].sort((a, b) => b.bytes - a.bytes || a.mac.localeCompare(b.mac)).slice(0, 20),
    people: [...roster.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId)),
  })
}
