import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, lte, max, ne } from 'drizzle-orm'
import type { BlockReasonT, PersonT } from '#shared/schemas/access'
import { StickyClient } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { appliedClientBlocks, clients, infraDevices, stickyFlags, stickyNudges } from '../../db/schema'
import { clientIdentities } from '../../services/client-identity'
import { systemContext, type ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { deviceMac, deviceState, deviceType } from '../../unifi/device-shape'
import type { WireDevice, WireStation } from '../../unifi/endpoints/schemas'
import { bytesPerSecondToBps } from '../../unifi/wan'
import type { WriteContext } from '../../unifi/writes'
import { DAY, HOUR, MINUTE } from '../access-time'
import type { createBlockReconciler } from '../blocks'

type Flag = typeof stickyFlags.$inferSelect
type Runtime = NonNullable<ControllerService['runtime']>
type Access = {
  blocks: ReturnType<typeof createBlockReconciler>
  desired: (at: number) => Map<string, BlockReasonT[]>
  roster: (at: number) => PersonT[]
}
const cooldown = 30 * MINUTE
const flagKey = (scope: string, mac: string) => and(eq(stickyFlags.scope, scope), eq(stickyFlags.mac, mac))

function otherAps(devices: readonly WireDevice[], station: WireStation, apMac: string,
  wlans: ReturnType<Runtime['cache']['snapshot']>['wlans']) {
  if (!station.essid) return 0
  const matching = wlans.filter(wlan => wlan.name === station.essid)
  if (matching.length && matching.every(wlan => wlan.enabled === false)) return 0
  return devices.filter(device => device.mac !== apMac && device.adopted !== false
    && deviceType(device) === 'ap' && deviceState(device) === 'online'
    && device.vap_table?.some(vap => vap.essid === station.essid && vap.up !== false && vap.enabled !== false)).length
}

export function createSticky(db: Db, service: ControllerService, access: Access, now = Date.now) {
  const settings = createSettingsService(db)
  const pending = new Map<string, { apMac: string, started: number, ts: number }>()
  let lastScope: string | undefined
  let lastMinute = -Infinity

  function nudgeStats(scope: string, mac: string, at: number) {
    return db.select({ nudges24h: count(), lastNudgeAt: max(stickyNudges.ts) }).from(stickyNudges).where(and(
      eq(stickyNudges.scope, scope), eq(stickyNudges.mac, mac), gt(stickyNudges.ts, at - DAY))).get()!
  }

  function recover(scope: string, mac: string, at: number) {
    if (scope === lastScope) pending.delete(mac)
    db.update(stickyFlags).set({ status: 'recovered', recoveredAt: at })
      .where(and(flagKey(scope, mac), ne(stickyFlags.status, 'recovered'))).run()
  }

  async function kick(mac: string, ctx: WriteContext, automatic?: { runtime: Runtime, apMac: string, active: () => boolean }) {
    return access.blocks.kick(mac, ctx, async runtime => {
      if (automatic && (runtime !== automatic.runtime || !automatic.active())) return { send: false }
      const [stations, known] = await Promise.all([runtime.api.activeClients(), runtime.api.knownClients()])
      const at = now()
      const { scope } = runtime
      const config = settings.get().sticky
      const station = stations.find(row => row.mac === mac)
      const apMac = station?.is_wired === true ? null : deviceMac(station?.ap_mac)
      if (!station || !apMac || !runtime.active() || automatic?.active() === false) return { send: false }
      if (automatic) {
        const flag = db.select().from(stickyFlags).where(flagKey(scope, mac)).get()
        const { devices, wlans } = runtime.cache.snapshot()
        if (!config.enabled || !config.nudge || !flag || flag.status === 'recovered'
          || apMac !== automatic.apMac || apMac !== flag.apMac || station.signal == null
          || station.signal > config.signalDbm || !otherAps(devices, station, apMac, wlans)) return { send: false }
      }
      const rx = bytesPerSecondToBps(station['rx_bytes-r'])
      const tx = bytesPerSecondToBps(station['tx_bytes-r'])
      if (rx === null || tx === null || rx + tx >= config.skipAboveBps) return { send: false }
      const stats = nudgeStats(scope, mac, at)
      if (stats.nudges24h >= config.maxNudgesPerDay || stats.lastNudgeAt !== null && at - stats.lastNudgeAt < cooldown) return { send: false }
      const physical = known.find(row => row.mac === mac)?.blocked
      const approval = db.select({ approval: clients.approval }).from(clients).where(eq(clients.mac, mac)).get()?.approval
      const owned = db.select().from(appliedClientBlocks).where(and(
        eq(appliedClientBlocks.controllerScope, scope), eq(appliedClientBlocks.mac, mac))).get()
      if ((physical ?? station.blocked) !== false || station.blocked === true || approval === 'blocked' || owned
        || access.roster(at).some(person => person.pause.active && person.deviceMacs.includes(mac)) || access.desired(at).has(mac)) {
        return { send: false }
      }
      return { send: true, wasBlocked: false, commit() {
        db.transaction(dbTx => {
          dbTx.insert(stickyNudges).values({ id: randomUUID(), scope, mac, ts: now() }).run()
          dbTx.update(stickyFlags).set({ status: 'nudged' })
            .where(and(flagKey(scope, mac), eq(stickyFlags.apMac, apMac), ne(stickyFlags.status, 'recovered'))).run()
        })
      } }
    })
  }

  async function sample(runtime: Runtime, at: number, active: () => boolean) {
    if (lastScope !== runtime.scope) {
      pending.clear()
      lastMinute = -Infinity
      lastScope = runtime.scope
    }
    const ts = Math.floor(at / MINUTE) * MINUTE
    if (ts <= lastMinute) return
    lastMinute = ts
    const { scope } = runtime
    const config = settings.get().sticky
    const { activeClients, devices, wlans } = runtime.cache.snapshot()
    const candidates: { mac: string, apMac: string }[] = []
    db.transaction(tx => {
      tx.delete(stickyFlags).where(lte(stickyFlags.recoveredAt, at - HOUR)).run()
      tx.delete(stickyNudges).where(lte(stickyNudges.ts, at - DAY)).run()
      if (!config.enabled) {
        pending.clear()
        tx.delete(stickyFlags).where(eq(stickyFlags.scope, scope)).run()
        return
      }
      const flags = new Map(tx.select().from(stickyFlags).where(eq(stickyFlags.scope, scope)).all().map(row => [row.mac, row]))
      const observed = new Set<string>()
      for (const station of activeClients) {
        const apMac = station.is_wired === true ? null : deviceMac(station.ap_mac)
        const { mac, signal } = station
        if (!apMac) continue
        observed.add(mac)
        let flag: Flag | undefined = flags.get(mac)
        if (flag && flag.status !== 'recovered' &&
          (flag.apMac !== apMac || signal != null && signal > config.signalDbm + 5)) {
          tx.update(stickyFlags).set({ status: 'recovered', recoveredAt: at,
            signal: flag.apMac === apMac ? signal ?? undefined : undefined }).where(flagKey(scope, mac)).run()
          pending.delete(mac)
          flag = undefined
        }
        const alternatives = otherAps(devices, station, apMac, wlans)
        if (flag && flag.status !== 'recovered') {
          tx.update(stickyFlags).set({ signal: signal ?? flag.signal, otherAps: alternatives }).where(flagKey(scope, mac)).run()
          pending.delete(mac)
        }
        if (signal == null || signal > config.signalDbm || !alternatives) {
          pending.delete(mac)
          continue
        }
        if (!flag || flag.status === 'recovered') {
          const previous = pending.get(mac)
          const started = previous?.apMac === apMac && previous.ts === ts - MINUTE ? previous.started : ts
          if (ts - started < (config.minutes - 1) * MINUTE) {
            pending.set(mac, { apMac, started, ts })
            continue
          }
          const fields = { apMac, signal, since: started, otherAps: alternatives, status: 'sticky' as const, recoveredAt: null }
          tx.insert(stickyFlags).values({ scope, mac, ...fields }).onConflictDoUpdate({
            target: [stickyFlags.scope, stickyFlags.mac], set: fields,
          }).run()
          pending.delete(mac)
        }
        if (config.nudge) {
          const stats = nudgeStats(scope, mac, at)
          const rx = bytesPerSecondToBps(station['rx_bytes-r'])
          const tx = bytesPerSecondToBps(station['tx_bytes-r'])
          if (rx !== null && tx !== null && rx + tx < config.skipAboveBps && stats.nudges24h < config.maxNudgesPerDay
            && (stats.lastNudgeAt === null || at - stats.lastNudgeAt >= cooldown)) candidates.push({ mac, apMac })
        }
      }
      for (const mac of pending.keys()) if (!observed.has(mac)) pending.delete(mac)
      // Keep active flags for sleeping or briefly disconnected stations. The API hides them until seen again.
    })
    for (const { mac, apMac } of candidates) {
      if (!active()) break
      await kick(mac, systemContext, { runtime, apMac, active }).catch(() => {})
    }
  }

  return {
    sample, recover, kick,
    list() {
      const runtime = service.runtime
      if (!runtime || !settings.get().sticky.enabled) return []
      const { scope } = runtime
      const at = now()
      const { activeClients, knownClients } = runtime.cache.snapshot()
      const active = new Map(activeClients.map(station => [station.mac, station]))
      const identity = clientIdentities(db, activeClients, knownClients)
      const names = new Map(db.select({ mac: infraDevices.mac, name: infraDevices.name }).from(infraDevices)
        .where(eq(infraDevices.scope, scope)).all().map(row => [row.mac, row.name]))
      return StickyClient.array().parse(db.select().from(stickyFlags).where(eq(stickyFlags.scope, scope))
        .orderBy(stickyFlags.since, stickyFlags.mac).all().flatMap(row => {
          const station = active.get(row.mac)
          const stats = nudgeStats(scope, row.mac, at)
          if (row.status === 'recovered') {
            if (row.recoveredAt === null || row.recoveredAt <= at - HOUR) return []
          } else {
            const associated = station?.is_wired !== true && deviceMac(station?.ap_mac) === row.apMac
            const reassociating = !station && row.status === 'nudged' && stats.lastNudgeAt !== null && at - stats.lastNudgeAt <= MINUTE
            if (!associated && !reassociating) return []
          }
          const client = identity.get(row.mac)
          return [{ ...row, displayName: client?.name ?? row.mac, personId: client?.personId ?? null,
            apName: names.get(row.apMac) ?? row.apMac, ...stats }]
        }))
    },
  }
}
