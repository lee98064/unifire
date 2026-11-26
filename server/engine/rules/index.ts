import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import {
  Rule, RuleInput, RuleRun, type RuleConditionT, type RuleInputT, type RuleRunT, type RuleT, type RuleTriggerT,
} from '#shared/schemas/automation'
import { Paged } from '#shared/schemas/common'
import type { Db } from '../../db'
import { clients, egressHealth, egresses, infraDevices, people, personDevices, quotas, ruleRuns, rules, usageMinutes } from '../../db/schema'
import { createAuditService, decodeCursor } from '../../services/audit'
import { wireTime } from '../../services/client-sync'
import type { ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import type { ControllerEvent } from '../../unifi/ws'
import { apiError } from '../../utils/api-error'
import { decrypt, encrypt } from '../../utils/crypto'
import { isSecretKey, redactSecrets, REDACTED } from '../../utils/redact'
import { bedtimeWindows, DAY, HOUR, MINUTE } from '../access-time'
import { createCronJobs, validateCron } from '../automation-cron'
import { httpUrl } from '../notifiers/channels'
import type { HttpTransport } from '../notifiers/telegram'
import { checkAccessActions } from './access-references'
import { createRuleActions, type RuleEvent } from './actions'

type Effects = Parameters<typeof createRuleActions>[2]
type Options = { now?: () => number, http?: HttpTransport }
const futureTriggers = new Set(['person.room_entered', 'person.room_left', 'incident.opened'])
const stateful = new Set(['device.offline', 'traffic.threshold'])
const mockHttp: HttpTransport = async (_url, init) => Response.json({ echo: init?.body ?? null })

export function matchesTrigger(trigger: RuleTriggerT, event: RuleEvent) {
  if (trigger.type !== event.type) return false
  if ('macs' in trigger && trigger.macs.length && !trigger.macs.some(mac => mac === event.mac)) return false
  if ('mac' in trigger && trigger.mac !== null && trigger.mac !== event.mac) return false
  if (trigger.type === 'infra.rebooted' && trigger.unexpectedOnly && event.unexpected !== true) return false
  if (trigger.type === 'infra.overheat' && (typeof event.tempC !== 'number' || event.tempC < trigger.celsius)) return false
  if ('switchMac' in trigger && trigger.switchMac !== null && trigger.switchMac !== event.switchMac) return false
  if (trigger.type === 'port.issue' && (typeof event.kind !== 'string' || trigger.kinds.length && !trigger.kinds.some(kind => kind === event.kind))) return false
  if (trigger.type === 'poe.budget' && (typeof event.percent !== 'number' || event.percent < trigger.percent)) return false
  if ('personId' in trigger && trigger.personId !== null && trigger.personId !== event.personId) return false
  if ('egressId' in trigger && trigger.egressId !== null && trigger.egressId !== event.egressId) return false
  if ('quotaId' in trigger && trigger.quotaId !== null && trigger.quotaId !== event.quotaId) return false
  return true
}

export function inRuleWindow(condition: Extract<RuleConditionT, { type: 'time' }>, at: number, timezone: string) {
  return bedtimeWindows([{ ...condition, enabled: true }], at, timezone).some(window => window.start <= at && at < window.end)
}

export function createRules(db: Db, service: ControllerService, effects: Effects, options: Options = {}) {
  const now = options.now ?? Date.now
  const apply = createRuleActions(db, service, effects, options.http ?? (service.status().mock ? mockHttp : fetch), now)
  const settings = createSettingsService(db)
  const audit = createAuditService(db)
  const jobs = createCronJobs()
  const operations = new Map<string, Promise<unknown>>()
  const latched = new Map<string, { skipped?: NonNullable<RuleRunT['skipped']> }>()
  const outages = new Map<string, number>()
  const heat = new Set<string>()
  const budget = new Set<string>()
  let infraScope = service.runtime?.scope
  const connections = new Map<string, { type: string, at: number, source?: 'poll' }>()
  let connectionScope = service.runtime
  let leased: (() => boolean) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let outageTimer: ReturnType<typeof setTimeout> | undefined
  let pruneAt = 0
  let lifecycle = new AbortController()
  const all = () => db.select().from(rules).orderBy(rules.createdAt, rules.id).all()
  const enabled = () => db.select().from(rules).where(eq(rules.enabled, true)).orderBy(rules.createdAt, rules.id).all()

  function row(id: string) {
    return db.select().from(rules).where(eq(rules.id, id)).get()
  }

  function internal(saved: typeof rules.$inferSelect) {
    return Rule.parse({ ...saved, actions: saved.encryptedActions ? decrypt(saved.encryptedActions) : saved.actions })
  }

  function publicRule(rule: RuleT) {
    return Rule.parse({ ...rule, actions: rule.actions.map(action => action.type === 'webhook'
      ? { ...action, headers: redactSecrets(action.headers) } : action) })
  }

  function requireRule(id: string) {
    const saved = row(id)
    if (!saved) throw apiError(404, 'RULE_NOT_FOUND', 'errors.ruleNotFound')
    return internal(saved)
  }

  function enrich(event: RuleEvent) {
    const mac = typeof event.mac === 'string' ? event.mac : undefined
    if (event.type.startsWith('infra.')) {
      const { scope: _scope, ...fields } = event
      const scope = service.runtime?.scope
      const device = mac && scope ? db.select().from(infraDevices)
        .where(and(eq(infraDevices.mac, mac), eq(infraDevices.scope, scope))).get() : undefined
      return { ...fields, device: device?.name ?? event.device ?? mac ?? '', model: device?.model ?? event.model ?? '',
        temp: event.tempC ?? '', version: event.version ?? device?.firmware ?? '', downtime: event.downSec ?? '' }
    }
    const client = mac ? db.select().from(clients).where(eq(clients.mac, mac)).get() : undefined
    const assigned = mac ? db.select().from(personDevices).where(eq(personDevices.mac, mac)).get() : undefined
    const personId = event.personId === undefined ? assigned?.personId : event.personId
    const person = typeof personId === 'string' ? db.select().from(people).where(eq(people.id, personId)).get()?.name : undefined
    const egress = typeof event.egressId === 'string' ? db.select().from(egresses).where(eq(egresses.id, event.egressId)).get()?.name : undefined
    const quota = typeof event.quotaId === 'string' ? db.select().from(quotas).where(eq(quotas.id, event.quotaId)).get()?.name : undefined
    const station = mac ? service.runtime?.cache.snapshot().activeClients.find(station => station.mac === mac) : undefined
    const wireIp = event.data && typeof event.data === 'object' && 'ip' in event.data ? event.data.ip : undefined
    const ip = event.ip ?? station?.ip ?? (typeof wireIp === 'string' ? wireIp : undefined)
    const name = client?.alias || client?.hostname || (typeof event.displayName === 'string' ? event.displayName : undefined)
      || client?.vendor || person || egress || quota || mac || (typeof event.name === 'string' ? event.name : undefined)
    // The raw UniFi document is unnecessary for templates and can carry private fields.
    const { data: _raw, ...fields } = event
    return { ...fields, ...(personId !== undefined && { personId }), ...(person && { person }),
      ...(egress && { egress }), ...(quota && { quota }), ...(name && { name }), ...(ip && { ip }) }
  }

  function conditionsPass(rule: Pick<RuleT, 'conditions'>, at: number, event: RuleEvent) {
    const config = settings.get()
    if (!rule.conditions.length) return true
    const roster = effects.access.people.rows(at)
    const runtime = service.runtime
    const online = new Set(runtime?.cache.snapshot().activeClients.map(station => station.mac))
    return rule.conditions.every(condition => {
      switch (condition.type) {
        case 'person.room': return false
        case 'time': return inRuleWindow(condition, at, config.timezone)
        case 'person.home': return roster.find(person => person.id === condition.personId)?.presence.home === condition.home
        case 'anyone.home': return roster.some(person => person.presence.home) === condition.home
        case 'egress.health': {
          const reading = db.select().from(egressHealth).where(eq(egressHealth.egressId, condition.egressId)).get()?.value
          return reading?.lastCheckAt != null && at - reading.lastCheckAt <= 2000 * config.probe.intervalSec
            && reading.status !== 'unknown' && (reading.status === 'healthy') === condition.healthy
        }
        case 'client.online': {
          if (condition.mac === event.mac && (event.type === 'client.connected' || event.type === 'client.disconnected')) {
            return condition.online === (event.type === 'client.connected')
          }
          const sampledAt = runtime?.cache.activeClientsAt()
          return sampledAt != null && at - sampledAt <= 45_000 && online.has(condition.mac) === condition.online
        }
      }
    })
  }

  function enqueue<T>(id: string, work: () => Promise<T>) {
    const task = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(work)
      .finally(() => { if (operations.get(id) === task) operations.delete(id) })
    operations.set(id, task)
    return task
  }

  function run(id: string, input: RuleEvent, test = false, requestedDryRun = false, actor?: { id: string, username: string }) {
    return enqueue(id, async () => {
      if (lifecycle.signal.aborted || !test && leased?.() === false) return
      const saved = row(id)
      if (!saved && test) requireRule(id)
      if (!saved || (!test && !saved.enabled)) return
      const rule = internal(saved)
      const ts = now()
      const event = enrich(input)
      if (!test && !matchesTrigger(rule.trigger, event)) return
      if (!test && rule.trigger.type === 'infra.offline') {
        const match = offlineDevice(input.mac, input.scope)
        if (!match || match.offlineSince !== input.offlineSince || match.offlineSince === null
          || ts - match.offlineSince < rule.trigger.minutes * MINUTE) return
      }
      const dryRun = requestedDryRun || service.status().mode === 'dry-run'
      const results: RuleRunT['results'] = []
      const skipped = test ? null
        : rule.lastRunAt !== null && ts - rule.lastRunAt < rule.cooldownSeconds * 1000 ? 'cooldown'
          : !conditionsPass(rule, ts, event) ? 'conditions' : null
      let changed = false
      const future = futureTriggers.has(rule.trigger.type) || rule.conditions.some(condition => condition.type === 'person.room')
      if (test && future) results.push({ action: rule.trigger.type, ok: false, message: 'rule.result.not_implemented' })
      else if (!skipped) {
        for (const action of rule.actions) {
          if (lifecycle.signal.aborted || leased?.() === false) break
          try {
            const result = await apply(action, rule, event, requestedDryRun || service.status().mode === 'dry-run', requestedDryRun, lifecycle.signal)
            results.push({ action: action.type, ok: result.ok, message: result.message })
            changed ||= result.changed
          } catch {
            results.push({ action: action.type, ok: false, message: action.type === 'webhook' ? 'rule.result.webhookFailed' : 'rule.result.failed' })
          }
        }
      }
      if (lifecycle.signal.aborted || leased?.() === false) return
      const outcome = RuleRun.parse({ id: randomUUID(), ruleId: id, ruleName: rule.name, ts,
        event: redactSecrets(event), test, dryRun, ok: results.every(result => result.ok), skipped, results })
      db.transaction(tx => {
        tx.insert(ruleRuns).values(outcome).run()
        if (!test && !skipped) tx.update(rules).set({ lastRunAt: ts, lastRunOk: outcome.ok,
          runCount: sql`${rules.runCount} + 1` }).where(eq(rules.id, id)).run()
        if (changed) audit.record({
          actor: { type: 'rule', id, name: rule.name },
          category: 'rule', action: 'rule.run', severity: outcome.ok ? 'success' : 'warning',
          target: { type: 'rule', id, label: rule.name }, messageKey: 'audit.rule.run',
          messageParams: { name: rule.name, initiatedBy: actor?.username ?? '' },
        }, ts)
      })
      return outcome
    })
  }

  function offlineDevice(mac: unknown, scope: unknown) {
    const runtime = service.runtime
    if (typeof mac !== 'string' || typeof scope !== 'string' || scope !== runtime?.scope || !runtime.active()) return
    return db.select().from(infraDevices).where(and(eq(infraDevices.mac, mac), eq(infraDevices.scope, scope),
      eq(infraDevices.lastState, 'offline'))).get()
  }

  function refreshInfraScope() {
    if (infraScope !== service.runtime?.scope) {
      infraScope = service.runtime?.scope
      outages.clear()
      heat.clear()
      budget.clear()
    }
    return infraScope
  }

  function evaluateOutages() {
    clearTimeout(outageTimer)
    if (leased?.() === false) return Promise.resolve([])
    const scope = refreshInfraScope()
    if (!scope || !service.runtime?.cache.devicePoll()) return Promise.resolve([])
    const candidates = enabled().filter(row => row.trigger.type === 'infra.offline')
    if (!candidates.length) {
      outages.clear()
      return Promise.resolve([])
    }
    const offline = db.select().from(infraDevices).where(and(eq(infraDevices.scope, scope),
      eq(infraDevices.lastState, 'offline'))).all()
    const pending: ReturnType<typeof run>[] = []
    const seen = new Set<string>()
    const at = now()
    let nextDue = Infinity
    for (const { id, trigger } of candidates) {
      if (trigger.type !== 'infra.offline') continue
      for (const { mac, offlineSince } of offline) {
        if (offlineSince === null || trigger.mac !== null && trigger.mac !== mac) continue
        const key = JSON.stringify([id, mac])
        seen.add(key)
        const due = offlineSince + trigger.minutes * MINUTE
        if (due > at) nextDue = Math.min(nextDue, due)
        if (due > at || outages.get(key) === offlineSince) continue
        outages.set(key, offlineSince)
        const prior = db.select({ id: ruleRuns.id }).from(ruleRuns).where(and(eq(ruleRuns.ruleId, id), eq(ruleRuns.test, false),
          gte(ruleRuns.ts, offlineSince), sql`json_extract(${ruleRuns.event}, '$.type') = 'infra.offline'`,
          sql`json_extract(${ruleRuns.event}, '$.mac') = ${mac}`,
          sql`json_extract(${ruleRuns.event}, '$.offlineSince') = ${offlineSince}`)).limit(1).get()
        if (!prior) pending.push(run(id, { type: trigger.type, mac, scope, offlineSince, downSec: (at - offlineSince) / 1000 })
          .then(result => {
            if (!result && outages.get(key) === offlineSince) outages.delete(key)
            return result
          }).catch(error => {
            if (outages.get(key) === offlineSince) outages.delete(key)
            throw error
          }))
      }
    }
    for (const key of outages.keys()) if (!seen.has(key)) outages.delete(key)
    if (leased && Number.isFinite(nextDue)) {
      outageTimer = setTimeout(() => { void evaluateOutages().catch(() => {}) }, nextDue - at)
      outageTimer.unref()
    }
    return Promise.all(pending)
  }

  function evaluateHeat(mac: string, tempC: number) {
    refreshInfraScope()
    for (const { id, trigger } of enabled()) {
      if (trigger.type !== 'infra.overheat' || trigger.mac !== null && trigger.mac !== mac) continue
      const key = JSON.stringify([id, mac])
      if (tempC <= trigger.celsius - 3) heat.delete(key)
      if (tempC < trigger.celsius || heat.has(key)) continue
      heat.add(key)
      void run(id, { type: 'infra.overheat', mac, tempC }).catch(() => { heat.delete(key) })
    }
  }

  function evaluateBudget(switchMac: string, percent: number) {
    refreshInfraScope()
    const event = { type: 'poe.budget', switchMac, percent }
    return Promise.all(enabled().flatMap(({ id, trigger }) => {
      if (trigger.type !== 'poe.budget' || trigger.switchMac !== null && trigger.switchMac !== switchMac) return []
      const key = JSON.stringify([id, switchMac])
      if (percent <= trigger.percent - 5) budget.delete(key)
      if (percent < trigger.percent || budget.has(key)) return []
      budget.add(key)
      return [run(id, event).catch(error => { budget.delete(key); throw error })]
    }))
  }

  function resetInfraRule(id: string) {
    const prefix = JSON.stringify(id)
    for (const key of budget) if (key.startsWith(`[${prefix},`)) budget.delete(key)
    for (const key of heat) if (key.startsWith(`[${prefix},`)) heat.delete(key)
    for (const key of outages.keys()) if (key.startsWith(`[${prefix},`)) outages.delete(key)
  }

  const dispatch = async (event: RuleEvent) => {
    if (futureTriggers.has(event.type)) return []
    if (event.type === 'poe.budget') return typeof event.switchMac === 'string' && typeof event.percent === 'number'
      ? evaluateBudget(event.switchMac, event.percent) : []
    if (event.type === 'infra.offline') return evaluateOutages()
    const interested = enabled().filter(row => row.trigger.type === event.type)
    if (!interested.length) return []
    const enriched = enrich(event)
    const targets = interested.filter(row => matchesTrigger(row.trigger, enriched))
    return Promise.all(targets.map(row => run(row.id, enriched)))
  }

  function onEvent(event: ControllerEvent) {
    if (!leased?.()) return
    if (event.type === 'rules.changed') {
      for (const id of event.ruleIds) {
        latched.delete(id)
        resetInfraRule(id)
        const saved = row(id)
        if (saved) sync(internal(saved))
        else jobs.set(id, null, async () => {})
      }
      return
    }
    if (event.type === 'poe.reading') {
      void evaluateBudget(event.switchMac, event.percent).catch(() => {})
      return
    }
    if (event.type === 'infra.temperature') return evaluateHeat(event.mac, event.tempC)
    if (event.type === 'infra.overheat') return // The rule uses its own threshold and hysteresis.
    if (event.type === 'infra.online' || event.type === 'cache.changed' && event.resource === 'devices') {
      void evaluateOutages().catch(() => {})
    }
    if (event.type === 'client.connected' || event.type === 'client.disconnected') {
      if (connectionScope !== service.runtime) {
        connections.clear()
        connectionScope = service.runtime
      }
      const at = now()
      const previous = connections.get(event.mac)
      // When a poll reports the same transition as the WebSocket, run the rule once.
      if (previous && at - previous.at < 30_000 && previous.type === event.type && previous.source !== event.source) return
      connections.set(event.mac, { type: event.type, at, source: event.source })
    }
    void dispatch(event).catch(() => {})
  }

  function level(trigger: RuleTriggerT, at: number): RuleEvent | null {
    if (trigger.type === 'device.offline') {
      const runtime = service.runtime
      const inventory = runtime?.cache.snapshot()
      const sampledAt = runtime?.cache.activeClientsAt()
      if (!runtime?.active() || !service.status().connected || sampledAt == null || at - sampledAt > 45_000 || !inventory) return null
      if (inventory.activeClients.some(station => station.mac === trigger.mac)) return null
      const device = inventory.devices.find(device => device.mac === trigger.mac)
      const last = db.select({ last: clients.lastSeen }).from(clients).where(eq(clients.mac, trigger.mac)).get()?.last
      const deviceSeen = typeof device?.last_seen === 'number' ? wireTime(device.last_seen) : null
      const lastSeen = Math.max(last ?? 0, deviceSeen ?? 0)
      return lastSeen && at - lastSeen >= trigger.minutes * MINUTE ? { type: trigger.type, mac: trigger.mac, lastSeen } : null
    }
    if (trigger.type === 'traffic.threshold') {
      const macs = trigger.scope.type === 'client' ? [trigger.scope.id]
        : db.select({ mac: personDevices.mac }).from(personDevices).where(eq(personDevices.personId, trigger.scope.id)).all().map(row => row.mac)
      if (!macs.length) return null
      const end = Math.floor(at / MINUTE) * MINUTE
      const { bytes } = db.select({ bytes: sql<number>`coalesce(sum(${usageMinutes.rxBytes} + ${usageMinutes.txBytes}), 0)` })
        .from(usageMinutes).where(and(inArray(usageMinutes.mac, macs), gte(usageMinutes.ts, end - trigger.windowMinutes * MINUTE),
          lt(usageMinutes.ts, end))).get() ?? { bytes: 0 }
      return bytes >= trigger.bytes ? { type: trigger.type, bytes, windowMinutes: trigger.windowMinutes,
        ...(trigger.scope.type === 'client' ? { mac: trigger.scope.id } : { personId: trigger.scope.id }) } : null
    }
    return null
  }

  function tick() {
    if (leased?.() === false) return
    const at = now()
    if (at >= pruneAt) {
      // Keep the run that deduplicates an outage until that device recovers.
      db.delete(ruleRuns).where(and(lt(ruleRuns.ts, at - 30 * DAY), sql`not exists (
        select 1 from ${infraDevices}
        where ${infraDevices.lastState} = 'offline'
          and json_extract(${ruleRuns.event}, '$.type') = 'infra.offline'
          and json_extract(${ruleRuns.event}, '$.mac') = ${infraDevices.mac}
          and json_extract(${ruleRuns.event}, '$.offlineSince') = ${infraDevices.offlineSince}
      )`)).run()
      for (const [mac, event] of connections) if (at - event.at >= 30_000) connections.delete(mac)
      pruneAt = at + HOUR
    }
    void evaluateOutages().catch(() => {})
    for (const row of enabled().filter(row => stateful.has(row.trigger.type))) {
      const event = level(row.trigger, at)
      if (!event) {
        latched.delete(row.id)
        continue
      }
      const previous = latched.get(row.id)
      if (previous) {
        if (!previous.skipped) continue
        if (previous.skipped === 'cooldown' && row.lastRunAt !== null && at - row.lastRunAt < 1000 * row.cooldownSeconds) continue
        if (previous.skipped === 'conditions' && !conditionsPass(row, at, event)) continue
      }
      const latch: NonNullable<typeof previous> = {}
      latched.set(row.id, latch)
      void run(row.id, event).then(result => {
        if (!result && latched.get(row.id) === latch) latched.delete(row.id)
        if (result?.skipped) latch.skipped = result.skipped
      }).catch(() => { if (latched.get(row.id) === latch) latched.delete(row.id) })
    }
  }

  function sync(rule: RuleT) {
    if (leased) jobs.set(rule.id, rule.enabled && rule.trigger.type === 'schedule' ? rule.trigger : null,
      () => leased?.() ? run(rule.id, { type: 'schedule' }) : Promise.resolve())
  }

  function save(id: string, input: Partial<RuleInputT>, current?: RuleT) {
    const fields = RuleInput.parse({ ...current, ...input })
    if (fields.trigger.type === 'schedule') validateCron(fields.trigger)
    checkAccessActions(db, fields.actions)
    fields.actions = fields.actions.map((action, index) => {
      if (action.type !== 'webhook') return action
      httpUrl(action.url)
      const same = current?.actions[index]
      const previous = same?.type === 'webhook' && same.url === action.url ? same
        : current?.actions.find(existing => existing.type === 'webhook' && existing.url === action.url)
      const oldHeaders = previous?.type === 'webhook' ? new Headers(previous.headers) : new Headers()
      const headers = Object.fromEntries(Object.entries(action.headers).map(([key, value]) => {
        if (isSecretKey(key) && value === REDACTED) {
          const old = oldHeaders.get(key)
          if (old === null) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
          return [key, old]
        }
        return [key, value]
      }))
      try { new Headers(headers) } catch { throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput') }
      return { ...action, headers }
    })
    const values = { ...fields, actions: [], encryptedActions: encrypt(fields.actions) }
    const saved = current ? db.update(rules).set(values).where(eq(rules.id, id)).returning().get()
      : db.insert(rules).values({ id, ...values, createdAt: now() }).returning().get()
    latched.delete(id)
    resetInfraRule(id)
    if (leased) void evaluateOutages().catch(() => {})
    const rule = internal(saved)
    sync(rule)
    return publicRule(rule)
  }

  function page(query: { ruleId?: string, limit: number, cursor?: string }) {
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit)))
    const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined
    const rows = db.select().from(ruleRuns).where(and(query.ruleId ? eq(ruleRuns.ruleId, query.ruleId) : undefined,
      cursor ? or(lt(ruleRuns.ts, cursor[0]), and(eq(ruleRuns.ts, cursor[0]), lt(ruleRuns.id, cursor[1]))) : undefined))
      .orderBy(desc(ruleRuns.ts), desc(ruleRuns.id)).limit(limit + 1).all()
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return Paged(RuleRun).parse({ items, nextCursor: last && rows.length > limit
      ? Buffer.from(JSON.stringify([last.ts, last.id])).toString('base64url') : null })
  }

  return {
    list: () => all().map(row => publicRule(internal(row))),
    get: (id: string) => publicRule(requireRule(id)),
    create: (input: RuleInputT) => save(randomUUID(), input),
    update: (id: string, input: Partial<RuleInputT>) => save(id, input, requireRule(id)),
    delete(id: string) {
      requireRule(id)
      db.delete(rules).where(eq(rules.id, id)).run()
      jobs.set(id, null, async () => {})
      latched.delete(id)
      resetInfraRule(id)
      return { ok: true as const }
    },
    async test(id: string, dryRun: boolean, actor?: { id: string, username: string }) {
      const { trigger, name } = requireRule(id)
      const scope = service.runtime?.scope
      const device = trigger.type.startsWith('infra.') && 'mac' in trigger && scope
        ? db.select().from(infraDevices).where(and(eq(infraDevices.scope, scope),
          trigger.mac ? eq(infraDevices.mac, trigger.mac) : undefined)).orderBy(infraDevices.mac).limit(1).get()
        : undefined
      const event: RuleEvent = { name, ...trigger, synthetic: true,
        ...(trigger.type.startsWith('infra.') && { mac: device?.mac ?? ('mac' in trigger ? trigger.mac : null) ?? '02:00:00:00:00:00',
          device: device?.name ?? name, model: device?.model ?? '' }),
        ...(trigger.type === 'infra.overheat' && { tempC: trigger.celsius }),
        ...(trigger.type === 'infra.rebooted' && { unexpected: trigger.unexpectedOnly }),
        ...(trigger.type === 'infra.online' && { downSec: 60 }),
        ...(trigger.type === 'infra.offline' && { downSec: trigger.minutes * 60 }),
        ...(trigger.type === 'infra.firmware' && { version: device?.upgradeTo ?? device?.firmware ?? '0.0.0' }),
        ...(trigger.type === 'port.issue' && { kind: trigger.kinds[0] ?? 'downgrade', portIdx: 1 }),
        ...('macs' in trigger && { mac: trigger.macs[0] }),
        ...(trigger.type === 'traffic.threshold' && (trigger.scope.type === 'client'
          ? { mac: trigger.scope.id } : { personId: trigger.scope.id })) }
      const result = await run(id, event, true, dryRun, actor)
      if (!result) throw apiError(503, 'UNIFI_INACTIVE', 'errors.unifiInactive')
      return result
    },
    page, dispatch, tick,
    start(hasLease: () => boolean) {
      lifecycle = new AbortController()
      leased = hasLease
      service.engine.on('event', onEvent)
      for (const row of enabled()) sync(internal(row))
      tick()
      timer = setInterval(tick, 10_000)
      timer.unref()
      return async () => {
        lifecycle.abort()
        clearInterval(timer)
        clearTimeout(outageTimer)
        service.engine.off('event', onEvent)
        jobs.stop()
        await Promise.allSettled(operations.values())
        leased = undefined
      }
    },
  }
}
