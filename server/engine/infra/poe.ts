import { randomUUID } from 'node:crypto'
import { and, eq, lte } from 'drizzle-orm'
import { PoeOverview, PoeQualification, PoeSchedule, PoeScheduleInput, type PoeOverrideInput, type PoeQualifyInputT,
  type PoeScheduleStatusT, type PortViewT } from '#shared/schemas/infra'
import type { z } from 'zod'
import type { Db } from '../../db'
import { poeApplied, poeOffLog, poeOverrides, poeSchedules, settings as settingsTable } from '../../db/schema'
import { createAuditService } from '../../services/audit'
import { systemContext, type ControllerService } from '../../services/controller'
import { createSettingsService, validateTimezone } from '../../services/settings'
import { deviceName, deviceState, normalizeDevice } from '../../unifi/device-shape'
import { UnifiError, unifiErrorCode } from '../../unifi/errors'
import { portIndex } from '../../unifi/poe-ports'
import { serializeSite, type WriteContext } from '../../unifi/writes'
import type { ControllerEvent } from '../../unifi/ws'
import { liveBus } from '../../utils/bus'
import { bedtimeWindows, DAY, HOUR, MINUTE } from '../access-time'
import { createPoeSafety, createDeviceGraph } from './poe-safety'
import { heldPort, poeQualificationKey, readPoeQualification, releasePoe } from './poe-state'
import { enrichPort, portIssues } from './port-health'
import { averageOnW, portKey, type PortKey } from './port-history'
import { buildPortViews } from './ports'

type Schedule = typeof poeSchedules.$inferSelect
type Hold = typeof poeApplied.$inferSelect
type Override = typeof poeOverrides.$inferSelect
type Runtime = NonNullable<ControllerService['runtime']>
type Input = z.output<typeof PoeScheduleInput>
type OverrideInput = z.output<typeof PoeOverrideInput>
type Desired = 'on' | 'off'
type Actual = Desired | 'unknown'
const portId = ({ switchMac, portIdx }: Omit<PortKey, 'scope'>) => switchMac + '/' + portIdx

function mergeWindows(windows: { start: number, end: number }[]) {
  const merged: typeof windows = []
  for (const window of windows.slice().sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end)
    else merged.push({ ...window })
  }
  return merged
}

export function poeWindows(schedule: Pick<Schedule, 'offWindows' | 'timezone'>, at: number) {
  return mergeWindows(bedtimeWindows(schedule.offWindows, at, schedule.timezone, 8))
}

export function offHoursPerWeek(windows: Input['offWindows']) {
  const week = 7 * DAY
  const clock = (hhmm: string) => (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * MINUTE
  const intervals = windows.filter(window => window.enabled).flatMap(window => window.days.flatMap(day => {
    const start = day * DAY + clock(window.start)
    let end = day * DAY + clock(window.end)
    if (end === start) return []
    if (end < start) end += DAY
    return end > week ? [{ start, end: week }, { start: 0, end: end - week }] : [{ start, end }]
  }))
  return mergeWindows(intervals).reduce((sum, window) => sum + window.end - window.start, 0) / HOUR
}

export function desiredPoe(schedule: Schedule | undefined, override: Override | undefined, at: number): Desired | null {
  if (override && (override.endsAt === null || override.endsAt > at)) return override.on ? 'on' : 'off'
  if (!schedule?.enabled || schedule.status === 'drift' || schedule.mode !== 'active') return null
  return poeWindows(schedule, at).some(window => window.start <= at) ? 'off' : 'on'
}

const actualMode = (mode: unknown): Actual => typeof mode !== 'string' ? 'unknown' : mode === 'off' ? 'off' : 'on'

function whyUnsafe(port: PortViewT | undefined, ack: boolean) {
  if (!port) return 'poe.reason.port_missing'
  if (!port.poeSafety.allowed) return `poe.reason.${port.poeSafety.reasons.find(reason => reason !== 'powers_ap') ?? 'not_poe'}`
  return port.poeSafety.requiresAck && !ack ? 'poe.reason.ack_required' : null
}

export function createPoe(db: Db, service: ControllerService, now = Date.now, bus = liveBus) {
  const audit = createAuditService(db, bus)
  const settings = createSettingsService(db)
  const queueKey = randomUUID()
  const operations = new Set<Promise<unknown>>()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let leased: (() => boolean) | undefined
  let inflight: Promise<unknown> | undefined
  let rerun = false
  let stopped = false

  const schedules = (scope: string) => db.select().from(poeSchedules).where(eq(poeSchedules.scope, scope))
    .orderBy(poeSchedules.createdAt, poeSchedules.id).all()
  const overrides = (scope: string) => db.select().from(poeOverrides).where(eq(poeOverrides.scope, scope)).all()
  const findSchedule = (key: PortKey) => db.select().from(poeSchedules).where(portKey(poeSchedules, key)).get()
  const findOverride = (key: PortKey) => db.select().from(poeOverrides).where(portKey(poeOverrides, key)).get()
  const holds = (scope: string) => db.select().from(poeApplied).where(eq(poeApplied.scope, scope)).all()
  const qualifyState = (run = service.runtime) => readPoeQualification(db, run?.scope, run?.status.networkVersion ?? null)
  const publish = (key: PortKey) => bus.emit({ type: 'poe', data: { switchMac: key.switchMac, portIdx: key.portIdx } })

  function runtime() {
    const run = service.runtime
    if (!run?.active() || stopped || leased?.() === false) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    return run
  }

  function serial<T>(work: () => T | Promise<T>) {
    const operation = serializeSite(queueKey, work).finally(() => operations.delete(operation))
    operations.add(operation)
    return operation
  }

  function inventory(run: Runtime, at: number) {
    const snapshot = run.cache.snapshot()
    const graph = createDeviceGraph(snapshot.devices)
    const { selfMac, selfIp } = service.status()
    const safety = createPoeSafety(graph, snapshot.activeClients, { mac: selfMac, ip: selfIp })
    const issues = portIssues(db, run.scope, settings.get().infra, at)
    return [...graph.byMac.values()].filter(device => deviceState(device) !== 'offline' && deviceState(device) !== 'restarting')
      .flatMap(device => {
        const info = normalizeDevice(device)
        if (!info.poe) return []
        const ports = buildPortViews(device, graph, snapshot.activeClients, safety, new Map()).map(view => {
          const key = { scope: run.scope, switchMac: device.mac, portIdx: view.idx }
          return enrichPort(db, key, view, at, issues.get(portId(key)) ?? [])
        })
        return [{ mac: device.mac, name: deviceName(device), model: info.model,
          budgetW: info.poe.budgetW, usedW: info.poe.usedW, ports }]
      })
  }

  function view(row: Schedule, switches: ReturnType<typeof inventory>, override: Override | undefined, at: number) {
    const device = switches.find(device => device.mac === row.switchMac)
    const port = device?.ports.find(port => port.idx === row.portIdx)
    const windows = poeWindows(row, at)
    const planned: Desired = windows.some(window => window.start <= at) ? 'off' : 'on'
    const desired = desiredPoe(row, override, at) ?? planned
    const actual = actualMode(port?.poe?.mode)
    const candidates = new Set(windows.flatMap(window => [window.start, window.end]).filter(ts => ts > at))
    if (override?.endsAt != null && override.endsAt > at) candidates.add(override.endsAt)
    const upcomingDesired = (ts: number) => desiredPoe(row, override, ts)
      ?? (poeWindows(row, ts).some(window => window.start <= ts) ? 'off' : 'on')
    const next = [...candidates].sort((a, b) => a - b).find(ts => upcomingDesired(ts) !== desired) ?? null
    const horizon = at + 48 * HOUR
    const offHours = offHoursPerWeek(row.offWindows)
    const avgW = averageOnW(db, row, at)
    const monthKwh = avgW === null ? null : avgW * offHours * 30 / 7 / 1000
    const { ratePerKwh } = settings.get().energy
    return PoeSchedule.parse({ ...row, switchName: device?.name ?? null, portName: port?.name ?? null, peerName: port?.peer?.name ?? null,
      state: { status: pending.has(portId(row)) ? 'pending' : row.status, desired, actual,
        reasonKey: row.reasonKey, reasonParams: row.reasonParams, nextChangeAt: next, nextDesired: next === null ? null : upcomingDesired(next),
        upcoming: windows.filter(window => window.start < horizon).map(window => ({ start: Math.max(at, window.start), end: Math.min(horizon, window.end) })),
        lastAppliedAt: row.lastAppliedAt },
      savings: { offHoursPerWeek: offHours, avgW, monthKwh, monthCost: monthKwh === null || ratePerKwh === null ? null : monthKwh * ratePerKwh },
    })
  }

  function overview() {
    const run = service.runtime
    const at = now()
    const switches = run ? inventory(run, at) : []
    const active = run ? overrides(run.scope).filter(row => row.endsAt === null || row.endsAt > at) : []
    const rows = run ? schedules(run.scope) : []
    return PoeOverview.parse({ qualification: qualifyState(run), switches, overrides: active,
      schedules: rows.map(row => view(row, switches, active.find(override => portId(override) === portId(row)), at)) })
  }

  function setStatus(row: Schedule | undefined, status: PoeScheduleStatusT, reasonKey: string | null = null,
    reasonParams: Record<string, string> = {}) {
    if (!row || row.status === status && row.reasonKey === reasonKey
      && JSON.stringify(row.reasonParams) === JSON.stringify(reasonParams)) return
    db.update(poeSchedules).set({ status, reasonKey, reasonParams }).where(eq(poeSchedules.id, row.id)).run()
    publish(row)
    if (status !== 'drift' && status !== 'blocked' && status !== 'error') return
    const params = { name: row.name, switch: row.switchMac, port: String(row.portIdx), reason: reasonKey ?? '', ...reasonParams }
    audit.record({ actor: systemContext.actor, category: 'poe', action: `poe.schedule.${status}`,
      severity: status === 'error' ? 'error' : 'warning', target: { type: 'poe_schedule', id: row.id, label: row.name },
      messageKey: `poe.reason.${status}`, messageParams: params }, now())
    service.engine.emit('event', { type: 'notification', event: 'poe_schedule', kind: status, ...params,
      switchMac: row.switchMac, portIdx: row.portIdx, scheduleId: row.id })
  }

  function applied(scheduleId: string | null, at: number) {
    if (scheduleId) db.update(poeSchedules).set({ lastAppliedAt: at }).where(eq(poeSchedules.id, scheduleId)).run()
  }

  function remember(key: PortKey, previous: { previousMode: string, createdEntry: boolean }, schedule: Schedule | undefined,
    source: Hold['source'], at: number) {
    db.insert(poeApplied).values({ ...key, ...previous, at, scheduleId: schedule?.id ?? null, source, phase: 'applying' }).run()
    publish(key)
  }

  function confirmOff(key: PortKey, schedule?: Schedule) {
    const hold = heldPort(db, key)
    if (!hold || hold.phase === 'held') return
    const at = now()
    db.transaction(tx => {
      db.update(poeApplied).set({ phase: 'held' }).where(portKey(poeApplied, key)).run()
      if (schedule && hold.source === 'schedule') {
        tx.insert(poeOffLog).values({ ...key, start: hold.at, end: null, scheduleId: schedule.id,
          scheduleName: schedule.name, avgW: averageOnW(tx, key, hold.at) }).onConflictDoNothing().run()
      }
      applied(hold.scheduleId, at)
    })
  }

  function confirmOn(key: PortKey, scheduleId: string | null, restored: boolean) {
    const at = now()
    db.transaction(tx => {
      releasePoe(tx, key, at, restored)
      if (restored) applied(scheduleId, at)
    })
    publish(key)
  }

  async function refresh(run: Runtime) {
    if (run.active() && !stopped) await run.cache.refreshAfterCurrent('devices').catch(() => {})
  }

  async function restore(run: Runtime, key: PortKey, hold: Hold, ctx: WriteContext) {
    const result = await run.writes.updatePortOverride(key.switchMac, key.portIdx,
      hold.createdEntry ? { remove: true } : { poe_mode: hold.previousMode }, ctx,
      { restoreMode: hold.previousMode,
        beforeSend: () => { db.update(poeApplied).set({ phase: 'restoring' }).where(portKey(poeApplied, key)).run() },
        readBack: () => confirmOn(key, hold.scheduleId, true) })
    if (!result.dryRun) await refresh(run)
    return result
  }

  async function reconcilePort(run: Runtime, key: PortKey, at: number, ctx: WriteContext, switches: ReturnType<typeof inventory>) {
    const row = findSchedule(key)
    const savedOverride = findOverride(key)
    const override = savedOverride && (savedOverride.endsAt === null || savedOverride.endsAt > at) ? savedOverride : undefined
    const source = override?.source ?? 'schedule'
    let hold = heldPort(db, key)
    const port = switches.find(device => device.mac === key.switchMac)?.ports.find(port => port.idx === key.portIdx)
    const actual = actualMode(port?.poe?.mode)
    const want = desiredPoe(row, override, at)
    const ack = override?.acknowledgedAp ?? row?.acknowledgedAp ?? false
    const blocked = whyUnsafe(port, ack)
    const activeSchedule = row?.enabled && row.mode === 'active' && row.status !== 'drift'
    const unsafeSchedule = !!blocked && (want === 'off' || activeSchedule)
    const globalDry = ctx.dryRun || service.status().mode === 'dry-run'
    const qualification = qualifyState(run)
    const inactive = row?.enabled ? row.mode === 'preview' ? 'preview' : 'ok' : 'disabled'
    const set = (status: PoeScheduleStatusT, reason?: string, params?: Record<string, string>) => {
      if (row?.status !== 'drift') setStatus(row, status, reason, params)
    }
    const pendingKey = portId(key)
    const offAuthorized = want === 'off' && !blocked
    try {
      if (hold) {
        // Cached telemetry can straddle a write. Confirm suspected drift via stat/device before releasing ownership.
        const fresh = await run.api.device(key.switchMac)
        const current = actualMode(fresh.port_table?.find(port => portIndex(port.port_idx) === key.portIdx)?.poe_mode)
        const configuredOff = fresh.port_overrides?.some(port => portIndex(port.port_idx) === key.portIdx && port.poe_mode === 'off')
        if (current === 'unknown') {
          set('blocked', 'poe.reason.port_missing')
          return
        }
        if (current === 'on' && (!configuredOff || hold.phase === 'held')) {
          if (hold.phase === 'held') {
            confirmOn(key, hold.scheduleId, false)
            if (override) db.delete(poeOverrides).where(portKey(poeOverrides, key)).run()
            if (row) setStatus(row, 'drift', 'poe.reason.drift')
            else {
              const event = { switchMac: key.switchMac, portIdx: key.portIdx, kind: 'drift', reason: 'poe.reason.drift',
                name: key.switchMac, switch: key.switchMac, port: String(key.portIdx) }
              audit.record({ actor: systemContext.actor, category: 'poe', action: 'poe.override.drift', severity: 'warning',
                target: { type: 'port', id: portId(key), label: event.port }, messageKey: event.reason, messageParams: { switch: event.switch, port: event.port, name: event.name, reason: event.reason } }, at)
              service.engine.emit('event', { type: 'notification', event: 'poe_schedule', ...event })
            }
            return
          }
          confirmOn(key, hold.scheduleId, hold.phase === 'restoring')
          hold = undefined
        } else if (hold.phase === 'applying' && current === 'off' && hold.source !== 'qualification') {
          confirmOff(key, row?.id === hold.scheduleId ? row : undefined)
          hold = heldPort(db, key)
        }
      }
      if (hold && (hold.phase === 'restoring' || hold.source === 'qualification'
        || (hold.source === 'snapshot' ? want === 'on' : !offAuthorized))) {
        pending.add(pendingKey)
        await restore(run, key, hold, ctx)
        set(globalDry ? 'dry_run' : unsafeSchedule ? 'blocked' : inactive,
          unsafeSchedule ? blocked : undefined)
        return
      }
      if (hold?.phase === 'applying' && hold.source !== 'snapshot') {
        set('error', 'poe.reason.error', { error: 'UNIFI_VERIFY_FAILED' })
        return
      }
      if (!want) { set(inactive); return }
      if (unsafeSchedule && blocked) { set('blocked', blocked); return }
      if (!port || actual === 'unknown') { set('blocked', 'poe.reason.port_missing'); return }
      if (!globalDry && !qualification.qualified) { set('unqualified', 'poe.reason.unqualified'); return }
      if (want === 'off' && actual !== 'off' && !hold) {
        pending.add(pendingKey)
        const result = await run.writes.updatePortOverride(key.switchMac, key.portIdx, { poe_mode: 'off' }, ctx, {
          acknowledgedAp: ack,
          beforeSend(previous) {
            const sentAt = now()
            if (desiredPoe(row, override, sentAt) !== 'off') throw new UnifiError('POE_DESIRED_CHANGED')
            remember(key, previous, source === 'schedule' ? row : undefined, source, sentAt)
          },
          readBack: () => confirmOff(key, row),
        })
        if (result.changed && !result.dryRun) await refresh(run)
      }
      set(globalDry ? 'dry_run' : 'ok', !hold && want === 'on' && actual === 'off' ? 'poe.reason.externally_off' : undefined)
    } catch (error) {
      const code = unifiErrorCode(error)
      if (code === 'POE_DESIRED_CHANGED') { wake(); return }
      if (code === 'POE_UNSAFE' || code === 'POE_ACK_REQUIRED') set('blocked', code === 'POE_ACK_REQUIRED' ? 'poe.reason.ack_required' : 'poe.reason.blocked')
      else if (code === 'POE_NOT_QUALIFIED') set('unqualified', 'poe.reason.unqualified')
      else set('error', 'poe.reason.error', { error: code })
      if (!row && code !== 'UNIFI_INACTIVE') {
        service.engine.emit('event', { type: 'notification', event: 'poe_schedule', kind: 'error', switchMac: key.switchMac,
          portIdx: key.portIdx, name: key.switchMac, switch: key.switchMac, port: String(key.portIdx), reason: 'poe.reason.error', error: code })
      }
      return error
    } finally {
      pending.delete(pendingKey)
    }
  }

  async function reconcile(ctx = systemContext) {
    const run = service.runtime
    if (!run?.active() || stopped || leased?.() === false) return
    const at = now()
    db.delete(poeOverrides).where(and(eq(poeOverrides.scope, run.scope), lte(poeOverrides.endsAt, at))).run()
    const switches = inventory(run, at)
    const ports = new Map([...schedules(run.scope), ...overrides(run.scope), ...holds(run.scope)]
      .map(({ scope, switchMac, portIdx }) => [portId({ switchMac, portIdx }), { scope, switchMac, portIdx }]))
    for (const key of ports.values()) {
      if (!run.active() || stopped || leased?.() === false) break
      await reconcilePort(run, key, now(), ctx, switches)
    }
  }

  function arm() {
    clearTimeout(timer)
    if (stopped || !leased?.()) return
    const run = service.runtime
    const at = now()
    const times = run ? [...schedules(run.scope).filter(row => row.enabled && row.mode === 'active' && row.status !== 'drift')
      .flatMap(row => poeWindows(row, at).flatMap(window => [window.start, window.end])),
      ...overrides(run.scope).flatMap(row => row.endsAt ?? [])].filter(ts => ts > at) : []
    timer = setTimeout(wake, Math.min(at + MINUTE, ...times) - at)
    timer.unref()
  }

  function wake() {
    if (stopped || !leased?.()) return
    if (inflight) { rerun = true; return }
    clearTimeout(timer)
    inflight = serial(() => reconcile()).catch(() => {}).finally(() => {
      inflight = undefined
      if (rerun) { rerun = false; wake() }
      else arm()
    })
  }

  function onEvent(event: ControllerEvent) {
    if (event.type === 'cache.changed' && event.resource === 'devices'
      || event.type === 'controller.mode' || event.type === 'controller.reconnected' || event.type === 'routing.settings') wake()
  }

  function byId(run: Runtime, id: string) {
    const row = db.select().from(poeSchedules).where(and(eq(poeSchedules.scope, run.scope), eq(poeSchedules.id, id))).get()
    if (!row) throw new UnifiError('POE_SCHEDULE_NOT_FOUND', 404)
    return row
  }

  function requirePort(switches: ReturnType<typeof inventory>, key: PortKey) {
    const port = switches.find(device => device.mac === key.switchMac)?.ports.find(port => port.idx === key.portIdx)
    if (!port) throw new UnifiError('POE_PORT_NOT_FOUND', 404)
    if (!port.poe?.capable) throw new UnifiError('POE_UNSAFE', 409)
    return port
  }

  async function restoreForRemoval(run: Runtime, row: Schedule, ctx: WriteContext) {
    const hold = heldPort(db, row)
    if (hold?.scheduleId !== row.id) return
    const result = await restore(run, row, hold, ctx)
    if (result.dryRun) throw new UnifiError('DRY_RUN', 409)
  }

  async function save(run: Runtime, input: Input, ctx: WriteContext, before?: Schedule) {
    validateTimezone(input.timezone)
    const at = now()
    const key = { scope: run.scope, switchMac: input.switchMac, portIdx: input.portIdx }
    const switches = inventory(run, at)
    if (!before || portId(before) !== portId(key)) requirePort(switches, key)
    const existing = findSchedule(key)
    if (existing && existing.id !== before?.id) throw new UnifiError('POE_SCHEDULE_EXISTS', 409)
    if (before && portId(before) !== portId(key)) await restoreForRemoval(run, before, ctx)
    const id = before?.id ?? randomUUID()
    if (before) db.update(poeSchedules).set(input).where(eq(poeSchedules.id, id)).run()
    else db.insert(poeSchedules).values({ ...key, ...input, id, createdAt: at,
      status: 'pending', reasonKey: null, reasonParams: {} }).run()
    await reconcilePort(run, key, at, ctx, switches)
    publish(key)
    arm()
    return view(byId(run, id), inventory(run, now()), findOverride(key), now())
  }

  return {
    overview,
    reconcile: () => serial(() => reconcile()),
    create: (input: Input, ctx: WriteContext) => serial(() => save(runtime(), input, ctx)),
    update: (id: string, input: Partial<Input>, ctx: WriteContext) => serial(() => {
      const run = runtime()
      const previous = byId(run, id)
      return save(run, PoeScheduleInput.parse({ ...previous, ...input }), ctx, previous)
    }),
    delete: (id: string, ctx: WriteContext) => serial(async () => {
      const run = runtime()
      const row = byId(run, id)
      await restoreForRemoval(run, row, ctx)
      db.delete(poeSchedules).where(eq(poeSchedules.id, id)).run()
      publish(row)
      arm()
      return { ok: true as const }
    }),
    resume: (id: string, ctx: WriteContext) => serial(async () => {
      const run = runtime()
      const row = byId(run, id)
      db.update(poeSchedules).set({ status: 'pending', enabled: true, reasonKey: null, reasonParams: {} }).where(eq(poeSchedules.id, id)).run()
      return save(run, PoeScheduleInput.parse({ ...row, enabled: true }), ctx, row)
    }),
    override: (input: OverrideInput, ctx: WriteContext, source: Override['source'] = 'manual') => serial(async () => {
      const run = runtime()
      const at = now()
      const key = { scope: run.scope, switchMac: input.switchMac, portIdx: input.portIdx }
      const switches = inventory(run, at)
      if (input.action === 'clear') {
        db.delete(poeOverrides).where(portKey(poeOverrides, key)).run()
      } else {
        if (input.on && !heldPort(db, key)) throw new UnifiError('POE_NOT_OWNED', 409)
        if (!input.on) {
          const port = requirePort(switches, key)
          if (!port.poeSafety.allowed) throw new UnifiError('POE_UNSAFE', 409)
          if (port.poeSafety.requiresAck && !input.acknowledgedAp) throw new UnifiError('POE_ACK_REQUIRED', 409)
          if (service.status().mode === 'live' && !ctx.dryRun && !qualifyState(run).qualified) throw new UnifiError('POE_NOT_QUALIFIED', 409)
        }
        const fields = { on: input.on, endsAt: input.minutes === null ? null : at + input.minutes * MINUTE,
          source, ruleId: source === 'rule' ? ctx.actor.id : null, acknowledgedAp: input.acknowledgedAp, createdAt: at }
        db.insert(poeOverrides).values({ ...key, ...fields }).onConflictDoUpdate({
          target: [poeOverrides.scope, poeOverrides.switchMac, poeOverrides.portIdx], set: fields,
        }).run()
      }
      const error = await reconcilePort(run, key, at, ctx, switches)
      publish(key)
      arm()
      if (error) throw error
      return overview()
    }),
    qualify: (input: PoeQualifyInputT, ctx: WriteContext) => serial(async () => {
      const run = runtime()
      if (service.status().mode !== 'live' || ctx.dryRun) throw new UnifiError('DRY_RUN', 409)
      const version = run.status.networkVersion
      if (!version) throw new UnifiError('POE_NOT_QUALIFIED', 409)
      const key = { scope: run.scope, switchMac: input.switchMac, portIdx: input.portIdx }
      if (heldPort(db, key)) throw new UnifiError('POE_NOT_OWNED', 409)
      const setting = poeQualificationKey(run.scope)
      function save(qualified: boolean, error: string | null) {
        const result = PoeQualification.parse({ qualified, at: now(), switchMac: key.switchMac, portIdx: key.portIdx, error })
        const value = { ...result, version }
        db.insert(settingsTable).values({ key: setting, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run()
        return result
      }
      let sent = false
      try {
        await run.writes.qualifyPoe(key.switchMac, key.portIdx, ctx, {
          acknowledgedAp: input.acknowledgedAp,
          beforeSend(previous) { remember(key, previous, undefined, 'qualification', now()); sent = true },
          rollback: () => sent ? heldPort(db, key) : undefined,
          beforeRestore: () => { db.update(poeApplied).set({ phase: 'restoring' }).where(portKey(poeApplied, key)).run() },
          readBack: mode => { if (mode !== 'off') confirmOn(key, null, true) },
        })
        return save(true, null)
      } catch (error) {
        if (sent || unifiErrorCode(error) === 'UNIFI_VERIFY_FAILED') save(false, unifiErrorCode(error))
        throw error
      } finally {
        if (sent) await refresh(run)
        publish(key)
        arm()
      }
    }),
    start(hasLease: () => boolean) {
      leased = hasLease
      service.engine.on('event', onEvent)
      wake()
      return async () => {
        stopped = true
        clearTimeout(timer)
        service.engine.off('event', onEvent)
        await Promise.allSettled([...operations])
      }
    },
  }
}
