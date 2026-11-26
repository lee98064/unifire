import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { clients, extensionRequests, pauseSchedules, people, personDevices, presenceSessions, quotas, settings } from '../db/schema'
import { DAY, MINUTE, localDate, quotaPeriod, zonedInstant } from '../engine/access-time'
import { createUsageStore } from '../engine/samplers/usage'
import { createSettingsService } from './settings'

export function seedMockAccess(db: Db, online: Set<string>, at = Date.now()) {
  const marker = 'access.demoSeeded'
  if (db.select().from(settings).where(eq(settings.key, marker)).get()) return
  const demo = db.select().from(people).all().filter(person => /^demo-person-[1-4]$/.test(person.id))
  if (demo.length !== 4) return
  const timezone = createSettingsService(db).get().timezone
  const devices = db.select().from(personDevices).all().filter(item => demo.some(person => person.id === item.personId))
  const assigned = new Set(devices.map(item => item.mac))
  const date = localDate(at, timezone)
  const week = [0, 1, 2, 3, 4, 5, 6]
  const history: Parameters<ReturnType<typeof createUsageStore>['record']>[0] = []
  const periods = { daily: quotaPeriod(at, timezone, 'daily') }
  db.transaction(tx => {
    tx.insert(quotas).values([
      { id: 'demo-kids-time', name: 'Kids screen time', scopeType: 'group', scopeId: 'demo-kids', metric: 'activeMinutes',
        period: 'daily', limit: 120, weekdayLimits: [null, null, null, null, null, 240, 240], action: { type: 'block' } },
      { id: 'demo-home-data', name: 'Monthly data', scopeType: 'person', scopeId: 'demo-person-1', metric: 'bytes',
        period: 'monthly', limit: 20_000_000_000, action: { type: 'notify' } },
    ]).onConflictDoNothing().run()
    for (const id of ['demo-person-3', 'demo-person-4']) {
      tx.insert(pauseSchedules).values({ id: `${id}-bedtime`, personId: id, days: week, start: '22:00', end: '07:00' })
        .onConflictDoNothing().run()
    }
    const candidates = tx.select().from(clients).all().filter(row => !assigned.has(row.mac) && row.approval === 'approved')
      .sort((a, b) => Number(online.has(a.mac)) - Number(online.has(b.mac)))
    const randomized = candidates.find(row => row.randomizedMac)
    for (const [index, row] of [randomized, ...candidates.filter(row => row !== randomized).slice(0, 2)].entries()) {
      if (row) tx.update(clients).set({ approval: 'pending', detectedAt: at - (index + 1) * 18 * MINUTE })
        .where(eq(clients.mac, row.mac)).run()
    }
    tx.insert(extensionRequests).values({ id: 'demo-extension', personId: 'demo-person-3', quotaId: 'demo-kids-time',
      amount: 30, reason: 'Finishing a school project', createdAt: Math.max(periods.daily.start, at - 45 * MINUTE),
      periodStart: periods.daily.start, expiresAt: periods.daily.end }).onConflictDoNothing().run()
    for (let day = 6; day >= 0; day--) {
      for (const [index, device] of devices.entries()) {
        const start = zonedInstant(date - day * DAY + (16 * 60 + index * 8) * MINUTE, timezone)
        if (device.presence && start < at) {
          const end = day === 0 && online.has(device.mac) ? null : Math.min(at, start + (5 * 60 + index * 3) * MINUTE)
          tx.insert(presenceSessions).values({ id: `demo-${device.personId}-${day}`, personId: device.personId,
            mac: device.mac, start, end }).onConflictDoNothing().run()
        }
        for (let minute = 0; minute < 38 + (day * 11 + index * 7) % 38; minute++) {
          const ts = start + minute * MINUTE
          if (ts >= at - MINUTE || (minute + index + day) % 6 === 0) continue
          const rxBytes = 580_000 + ((minute * 652_087 + day * 775_231 + index * 839_109) % 14_000_000)
          history.push({ mac: device.mac, ts, rxBytes, txBytes: Math.floor(rxBytes / (6 + index % 4)), active: true })
        }
      }
    }
    createUsageStore(db).record(history, timezone)
    tx.insert(settings).values({ key: marker, value: true }).run()
  })
}
