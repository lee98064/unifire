import { poeGrace } from '../db/schema'
import { portKey } from './infra/port-history'
import { heldPort } from './infra/poe-state'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connect, isIP } from 'node:net'
import { promisify } from 'node:util'
import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { PoePort, PoeWatchdog, WatchdogEvent, type PoeWatchdogInput, type PoeWatchdogT } from '#shared/schemas/automation'
import type { Db } from '../db'
import { clients, poeWatchdogs, watchdogEvents } from '../db/schema'
import { createAuditService } from '../services/audit'
import { systemContext, type ControllerService } from '../services/controller'
import { createSettingsService } from '../services/settings'
import { UnifiError } from '../unifi/errors'
import { assertPoePort, isUplink, poeCapable, portIndex } from '../unifi/poe-ports'
import type { WriteContext } from '../unifi/writes'
import { apiError } from '../utils/api-error'
import { localDate, MINUTE } from './access-time'
import type { Notification } from './notifiers'

type Input = z.output<typeof PoeWatchdogInput>
type State = PoeWatchdogT['state']
type Probe = (watchdog: Input) => Promise<number | null>
const exec = promisify(execFile)

export const initialWatchdogState = (enabled: boolean): State => ({ status: enabled ? 'unknown' : 'disabled',
  consecutiveFails: 0, lastCheckAt: null, lastOkAt: null, lastCycleAt: null, cyclesToday: 0, lastLatencyMs: null })

async function liveProbe({ targetIp, method, tcpPort }: Input): Promise<number | null> {
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)
  if (method === 'icmp') {
    const darwin = process.platform === 'darwin'
    const binary = darwin && isIP(targetIp) === 6 ? 'ping6' : 'ping'
    const { stdout } = await exec(binary, ['-c1', darwin ? '-W2000' : '-W2', targetIp],
      { timeout: 2500, maxBuffer: 16_384 }).catch((error: NodeJS.ErrnoException) => {
      if (typeof error.code === 'string') throw error
      return { stdout: '' }
    })
    const latency = /time[=<]([\d.]+)\s*ms/.exec(stdout)
    return latency ? Number(latency[1]) : null
  }
  return new Promise(resolve => {
    const socket = connect({ host: targetIp, port: tcpPort!, timeout: 2000 })
    const finish = (latency: number | null) => { socket.destroy(); resolve(latency) }
    socket.once('connect', () => finish(elapsed()))
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}

export function createWatchdogs(db: Db, service: ControllerService, notify: (event: Notification) => Promise<void>, options: {
  probe?: Probe, now?: () => number
} = {}) {
  const now = options.now ?? Date.now
  const probe = options.probe ?? (service.status().mock
    ? async (target: Input) => service.mockWatchdogProbe?.(target.targetIp, now()) ?? null : liveProbe)
  const audit = createAuditService(db)
  const settings = createSettingsService(db)
  const pending = new Map<string, Promise<unknown>>()
  const previews = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | undefined
  let leased: (() => boolean) | undefined

  function runtime() {
    const run = service.runtime
    if (!run?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    return run
  }

  async function ports() {
    const run = runtime()
    const devices = await run.api.devices()
    const active = run.cache.snapshot().activeClients
    const names = new Map(db.select().from(clients).all().map(row => [row.mac, row.alias || row.hostname || row.vendor || row.mac]))
    const ports = devices.flatMap(device => (device.port_table ?? []).flatMap(port => {
      const index = portIndex(port.port_idx)
      if (index === null || !poeCapable(port) || isUplink(device, port)) return []
      const client = active.find(station => station.sw_mac?.toLowerCase() === device.mac && station.sw_port === index)
      const power = typeof port.poe_power === 'string' && port.poe_power.trim() ? Number(port.poe_power) : port.poe_power
      return [{ switchMac: device.mac, switchName: device.name || device.model || device.mac, portIdx: index,
        portName: typeof port.name === 'string' ? port.name : `Port ${index}`, poe: true, isUplink: false,
        up: port.up === true, powerW: typeof power === 'number' && Number.isFinite(power) ? power : null,
        connectedClientMac: client?.mac ?? null,
        connectedClientName: client ? names.get(client.mac) ?? client.hostname ?? client.name ?? client.mac : null }]
    }))
    return PoePort.array().parse(ports)
  }

  function get(id: string) {
    const row = db.select().from(poeWatchdogs).where(eq(poeWatchdogs.id, id)).get()
    if (!row) throw apiError(404, 'WATCHDOG_NOT_FOUND', 'errors.watchdogNotFound')
    return row
  }

  function dayState(state: State, at: number) {
    const zone = settings.get().timezone
    if (state.lastCycleAt !== null && localDate(state.lastCycleAt, zone) !== localDate(at, zone)) {
      return { ...state, cyclesToday: 0, status: state.status === 'limit' ? 'unknown' as const : state.status }
    }
    return state
  }

  function view(row: ReturnType<typeof get>) {
    const device = service.runtime?.cache.snapshot().devices.find(item => item.mac === row.switchMac)
    return PoeWatchdog.parse({ ...row, switchName: device?.name ?? row.switchName,
      state: dayState(row.state, now()) })
  }

  async function save(id: string, input: Input, current?: ReturnType<typeof get>) {
    if (!isIP(input.targetIp) || input.method === 'tcp' && input.tcpPort === null) {
      throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
    }
    const changedPort = !current || input.switchMac !== current.switchMac || input.portIdx !== current.portIdx
    const device = changedPort ? assertPoePort(await runtime().api.devices(), input.switchMac, input.portIdx) : undefined
    const samePort = db.select().from(poeWatchdogs).where(and(eq(poeWatchdogs.switchMac, input.switchMac),
      eq(poeWatchdogs.portIdx, input.portIdx))).get()
    if (samePort && samePort.id !== id) throw apiError(409, 'WATCHDOG_DUPLICATE_PORT', 'errors.watchdogDuplicatePort')
    const state = current && !changedPort ? { ...current.state,
      status: !input.enabled ? 'disabled' as const : current.enabled ? current.state.status : 'unknown' as const,
      ...(current.enabled !== input.enabled && { consecutiveFails: 0, lastCheckAt: null }),
    } : initialWatchdogState(input.enabled)
    const fields = { ...input, state, switchName: device?.name ?? device?.model ?? (changedPort ? input.switchMac : current?.switchName ?? null) }
    const row = current ? db.update(poeWatchdogs).set(fields).where(eq(poeWatchdogs.id, id)).returning().get()
      : db.insert(poeWatchdogs).values({ id, ...fields }).returning().get()
    return view(row)
  }

  function record(id: string, kind: typeof watchdogEvents.$inferInsert.kind, at: number) {
    db.insert(watchdogEvents).values({ id: randomUUID(), watchdogId: id, ts: at, kind, message: `watchdog.event.${kind}` }).run()
  }

  function state(id: string, next: State) {
    db.update(poeWatchdogs).set({ state: next }).where(eq(poeWatchdogs.id, id)).run()
  }

  function poeHold(switchMac: string, portIdx: number) {
    const scope = service.runtime?.scope
    if (!scope) return false
    const key = { scope, switchMac, portIdx }
    const grace = db.select().from(poeGrace).where(portKey(poeGrace, key)).get()
    return !!heldPort(db, key) || (grace?.until ?? 0) > now()
  }

  async function command(switchMac: string, portIdx: number, ctx: WriteContext) {
    return runtime().writes.deviceAction({ cmd: 'power-cycle', mac: switchMac, port_idx: portIdx }, ctx, false, () => !poeHold(switchMac, portIdx))
  }

  async function cycle(row: ReturnType<typeof get>, ctx: WriteContext, at: number, next: State) {
    if (poeHold(row.switchMac, row.portIdx)) throw new UnifiError('POE_HELD', 409)
    if (next.cyclesToday >= row.maxCyclesPerDay) {
      if (next.status !== 'limit') record(row.id, 'limit', at)
      state(row.id, { ...next, status: row.enabled ? 'limit' : 'disabled' })
      throw apiError(409, 'WATCHDOG_DAILY_LIMIT', 'errors.watchdogDailyLimit')
    }
    const preview = ctx.dryRun || service.status().mode === 'dry-run'
    if (!preview) state(row.id, { ...next, status: 'cycling' })
    try {
      const result = await command(row.switchMac, row.portIdx, ctx)
      if (result.dryRun) {
        if (!ctx.dryRun) {
          previews.set(row.id, at)
          state(row.id, { ...next, status: row.enabled ? 'cooldown' : 'disabled' })
        }
        return result
      }
      previews.delete(row.id)
      db.transaction(() => {
        state(row.id, { ...next, status: row.enabled ? 'cooldown' : 'disabled', consecutiveFails: 0,
          lastCycleAt: at, cyclesToday: next.cyclesToday + 1 })
        record(row.id, 'cycle', at)
        audit.record({ actor: ctx.actor, category: 'poe', action: 'watchdog.cycle', severity: 'warning',
          target: { type: 'watchdog', id: row.id, label: row.name }, messageKey: 'audit.watchdog.cycle', messageParams: { name: row.name } }, at)
      })
      await notify({ event: 'poe_cycle', data: { name: row.name, watchdogId: row.id, switchMac: row.switchMac, portIdx: row.portIdx } }).catch(() => {})
      return result
    } catch (error) {
      if (!ctx.dryRun) {
        state(row.id, { ...next, status: row.enabled ? 'failing' : 'disabled' })
        record(row.id, 'error', at)
      }
      throw error
    }
  }

  function serialize<T>(id: string, work: () => T | Promise<T>) {
    const task = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(work)
      .finally(() => { if (pending.get(id) === task) pending.delete(id) })
    pending.set(id, task)
    return task
  }

  function check(id: string) {
    if (pending.has(id)) return Promise.resolve()
    return serialize(id, async () => {
      const row = get(id)
      if (!row.enabled || poeHold(row.switchMac, row.portIdx)) return
      const at = now()
      const next = dayState(row.state, at)
      let latency: number | null
      try { latency = await probe(row) }
      catch {
        if (leased?.() === false) return
        state(id, { ...next, status: 'unknown', consecutiveFails: 0, lastCheckAt: at, lastLatencyMs: null })
        record(id, 'error', at)
        return
      }
      if (leased?.() === false || poeHold(row.switchMac, row.portIdx)) return
      next.lastCheckAt = at
      next.lastLatencyMs = latency
      if (latency !== null) {
        if (next.consecutiveFails > 0 || ['cooldown', 'limit', 'cycling'].includes(next.status)) record(id, 'recovered', at)
        state(id, { ...next, status: 'ok', lastOkAt: at, consecutiveFails: 0 })
        return
      }
      if (next.consecutiveFails === 0) record(id, 'fail', at)
      next.consecutiveFails++
      const last = Math.max(next.lastCycleAt ?? -Infinity, previews.get(id) ?? -Infinity)
      if (next.cyclesToday >= row.maxCyclesPerDay) {
        if (next.status !== 'limit') record(id, 'limit', at)
        state(id, { ...next, status: 'limit' })
      } else if (at - last < row.cooldownMin * MINUTE) {
        state(id, { ...next, status: 'cooldown' })
      } else if (next.consecutiveFails >= row.failThreshold) {
        await cycle(row, systemContext, at, next)
      } else state(id, { ...next, status: 'failing' })
    })
  }

  function tick() {
    if (!leased?.() || !service.runtime?.active() || !service.status().connected) return
    const at = now()
    for (const row of db.select().from(poeWatchdogs).where(eq(poeWatchdogs.enabled, true)).all()) {
      if (row.state.lastCheckAt === null || at - row.state.lastCheckAt >= row.intervalSec * 1000) void check(row.id).catch(() => {})
    }
  }

  return {
    ports, check, poeHold,
    list: () => db.select().from(poeWatchdogs).orderBy(poeWatchdogs.name, poeWatchdogs.id).all().map(view),
    create: (input: Input) => save(randomUUID(), input),
    update: (id: string, input: Partial<Input>) => serialize(id, () => {
      const current = get(id)
      return save(id, { ...current, ...input }, current)
    }),
    delete: (id: string) => serialize(id, () => {
      get(id)
      db.transaction(tx => {
        tx.delete(watchdogEvents).where(eq(watchdogEvents.watchdogId, id)).run()
        tx.delete(poeWatchdogs).where(eq(poeWatchdogs.id, id)).run()
      })
      previews.delete(id)
      return { ok: true as const }
    }),
    cycle: (id: string, ctx: WriteContext) => serialize(id, async () => {
      const row = get(id)
      await cycle(row, ctx, now(), dayState(row.state, now()))
      return view(get(id))
    }),
    cyclePort(switchMac: string, portIdx: number, ctx: WriteContext) {
      const row = db.select().from(poeWatchdogs).where(and(eq(poeWatchdogs.switchMac, switchMac), eq(poeWatchdogs.portIdx, portIdx))).get()
      if (!row) return command(switchMac, portIdx, ctx).then(async result => {
        if (result.changed && !result.dryRun) {
          const name = service.runtime?.cache.snapshot().devices.find(device => device.mac === switchMac)?.name ?? switchMac
          await notify({ event: 'poe_cycle', data: { name, switchMac, portIdx } }).catch(() => {})
        }
        return result
      })
      return serialize(row.id, () => {
        const current = get(row.id)
        if (current.switchMac !== switchMac || current.portIdx !== portIdx) throw new UnifiError('UNSAFE_POE_PORT', 409)
        const at = now()
        if (at - (current.state.lastCycleAt ?? -Infinity) < current.cooldownMin * MINUTE) {
          throw apiError(409, 'WATCHDOG_COOLDOWN', 'errors.watchdogCooldown')
        }
        return cycle(current, ctx, at, dayState(current.state, at))
      })
    },
    events(id: string) {
      get(id)
      return WatchdogEvent.array().parse(db.select().from(watchdogEvents).where(eq(watchdogEvents.watchdogId, id))
        .orderBy(desc(watchdogEvents.ts), desc(watchdogEvents.id)).all())
    },
    start(hasLease: () => boolean) {
      leased = hasLease
      timer = setInterval(tick, 1000)
      timer.unref()
      return async () => {
        leased = () => false
        clearInterval(timer)
        await Promise.allSettled(pending.values())
      }
    },
  }
}
