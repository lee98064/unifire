import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, gte, lt, lte } from 'drizzle-orm'
import { ClientRoams } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { clientRfMinutes, clientRoams, infraDevices } from '../../db/schema'
import { deviceMac, finiteNumber } from '../../unifi/device-shape'
import type { WireStation } from '../../unifi/endpoints/schemas'
import { DAY, HOUR, MINUTE } from '../access-time'

type Source = typeof clientRoams.$inferSelect['source']
type Location = { apMac: string, signal: number | null, observedAt: number, wsAt: number, pendingRoam?: { id: string, ts: number } }
const dedupeMs = 90_000
const bandByRadio = new Map([['ng', '2.4'], ['na', '5'], ['6e', '6']])

export function createRoamTracker(db: Db, onRoam: (scope: string, mac: string, at: number) => void) {
  const locations = new Map<string, Location>()
  let scope: string | undefined
  let nextPrune = 0

  function observe(controllerScope: string, station: WireStation, source: Source, at: number, startedAt = at) {
    if (scope !== controllerScope) {
      locations.clear()
      scope = controllerScope
    }
    const { mac } = station
    const cached = locations.get(mac)
    const previous = cached && at - cached.observedAt <= dedupeMs ? cached : undefined
    // A poll already in flight when an STA frame arrived can contain the old association.
    if (previous && (previous.observedAt > at || source === 'poll' && previous.wsAt > startedAt)) return
    const apMac = station.is_wired === true ? null : deviceMac(station.ap_mac)
    if (!apMac) {
      if (source === 'poll' || station.is_wired === true) locations.delete(mac)
      return
    }
    const signal = station.signal ?? null
    const next: Location = { apMac, signal, observedAt: at, wsAt: source === 'ws' ? at : previous?.wsAt ?? -Infinity }
    locations.set(mac, next)
    if (!previous) return
    const band = bandByRadio.get(station.radio ?? '') ?? null
    const channelValue = finiteNumber(station.channel)
    const channel = channelValue !== null && Number.isInteger(channelValue) ? channelValue : null
    if (previous.apMac === apMac) {
      next.signal ??= previous.signal
      const pending = previous.pendingRoam
      if (pending && at - pending.ts <= dedupeMs) {
        if (source === 'poll') next.pendingRoam = pending
        else db.update(clientRoams).set({ source, toSignal: signal ?? undefined, band: band ?? undefined, channel: channel ?? undefined })
          .where(eq(clientRoams.id, pending.id)).run()
      }
      return
    }

    db.transaction(tx => {
      const duplicate = tx.select().from(clientRoams).where(and(eq(clientRoams.scope, controllerScope),
        eq(clientRoams.mac, mac), eq(clientRoams.toApMac, apMac), gte(clientRoams.ts, at - dedupeMs), lte(clientRoams.ts, at + dedupeMs)))
        .orderBy(clientRoams.ts).limit(1).get()
      const id = duplicate?.id ?? randomUUID()
      if (!duplicate) {
        tx.insert(clientRoams).values({ id, scope: controllerScope, mac, ts: at,
          fromApMac: previous.apMac, toApMac: apMac, fromSignal: previous.signal, toSignal: signal, band, channel, source }).run()
      } else {
        // Keep the original AP and timestamp. Prefer RF metadata from an STA frame for that transition.
        const preferWs = duplicate.source === 'poll' && source === 'ws'
        const fromSignal = duplicate.fromApMac === previous.apMac ? previous.signal ?? duplicate.fromSignal : duplicate.fromSignal
        tx.update(clientRoams).set({ ts: Math.min(at, duplicate.ts),
          ...(preferWs && { source, fromSignal,
            toSignal: signal ?? duplicate.toSignal, band: band ?? duplicate.band, channel: channel ?? duplicate.channel }) })
          .where(eq(clientRoams.id, id)).run()
      }
      if (source === 'poll' && duplicate?.source !== 'ws') next.pendingRoam = { id, ts: Math.min(at, duplicate?.ts ?? at) }
      onRoam(controllerScope, mac, at)
    })
  }

  return {
    observe,
    poll(controllerScope: string, stations: readonly WireStation[], at: number, startedAt = at) {
      if (scope !== controllerScope) {
        locations.clear()
        scope = controllerScope
      }
      const seen = new Set(stations.map(row => row.mac))
      for (const [mac, location] of locations) if (!seen.has(mac) && at - location.observedAt > dedupeMs) locations.delete(mac)
      for (const station of stations) observe(controllerScope, station, 'poll', at, startedAt)
    },
    sample(controllerScope: string, stations: readonly WireStation[], at: number) {
      const ts = Math.floor(at / MINUTE) * MINUTE
      db.transaction(tx => {
        for (const station of stations) {
          const apMac = station.is_wired === true ? null : deviceMac(station.ap_mac)
          if (!apMac) continue
          tx.insert(clientRfMinutes).values({ scope: controllerScope, mac: station.mac, ts, apMac, signal: station.signal ?? null })
            .onConflictDoNothing().run()
        }
        if (at >= nextPrune) {
          tx.delete(clientRfMinutes).where(lt(clientRfMinutes.ts, at - 7 * DAY)).run()
          tx.delete(clientRoams).where(lt(clientRoams.ts, at - 90 * DAY)).run()
        }
      })
      if (at >= nextPrune) nextPrune = at + HOUR
    },
  }
}

export function clientRoamHistory(db: Db, scope: string, mac: string, from: number, to: number) {
  const names = new Map(db.select({ mac: infraDevices.mac, name: infraDevices.name }).from(infraDevices)
    .where(eq(infraDevices.scope, scope)).all().map(row => [row.mac, row.name]))
  const events = db.select().from(clientRoams)
    .where(and(eq(clientRoams.scope, scope), eq(clientRoams.mac, mac), gte(clientRoams.ts, from), lte(clientRoams.ts, to)))
    .orderBy(asc(clientRoams.ts), asc(clientRoams.id)).all().map(row => ({
      ...row, fromApName: names.get(row.fromApMac) ?? null, toApName: names.get(row.toApMac) ?? null,
    }))
  const samples = db.select().from(clientRfMinutes)
    .where(and(eq(clientRfMinutes.scope, scope), eq(clientRfMinutes.mac, mac), gte(clientRfMinutes.ts, from), lte(clientRfMinutes.ts, to)))
    .orderBy(clientRfMinutes.ts).all()
  const dwell = new Map<string, number>()
  const points = new Map<number, { ts: number, dbm: number | null, apMac: string }>()
  const stride = Math.max(1, Math.ceil((Math.floor(to / MINUTE) - Math.ceil(from / MINUTE) + 1) / 1440))
  for (const row of samples) {
    dwell.set(row.apMac, (dwell.get(row.apMac) ?? 0) + 1)
    points.set(Math.floor((Math.floor(row.ts / MINUTE) - Math.ceil(from / MINUTE)) / stride),
      { ts: row.ts, dbm: row.signal, apMac: row.apMac })
  }
  const apDwell = [...dwell].map(([apMac, minutes]) => ({ apMac, apName: names.get(apMac) ?? apMac, minutes }))
  return ClientRoams.parse({ mac, from, to, events, signal: [...points.values()], apDwell })
}

export function apRoams24h(db: Db, scope: string, mac: string, at: number) {
  const window = and(eq(clientRoams.scope, scope), gte(clientRoams.ts, at - DAY), lte(clientRoams.ts, at))
  const into = db.select({ n: count() }).from(clientRoams).where(and(window, eq(clientRoams.toApMac, mac))).get()
  const out = db.select({ n: count() }).from(clientRoams).where(and(window, eq(clientRoams.fromApMac, mac))).get()
  return { in: into?.n ?? 0, out: out?.n ?? 0 }
}
