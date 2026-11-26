import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { QuotaStatusT, QuotaT, PersonT } from '#shared/schemas/access'
import { Mac } from '#shared/schemas/common'
import type { Db } from '../db'
import { clients, egresses, extensionRequests, groups, people, quotaTransitions, quotas } from '../db/schema'
import { quotaPeriod } from '../engine/access-time'
import { createUsageStore } from '../engine/samplers/usage'
import type { EngineEvents } from '../unifi/ws'
import { apiError } from '../utils/api-error'
import { liveBus } from '../utils/bus'

export type QuotaEvaluation = {
  quota: QuotaT
  status: QuotaStatusT
  personId: string | null
  subject: string
  macs: string[]
  start: number
}

function toQuota({ scopeId, scopeType, ...row }: typeof quotas.$inferSelect): QuotaT {
  return { ...row, scope: { type: scopeType, id: scopeId } }
}

export function createQuotaService(db: Db, engine: EngineEvents) {
  const usage = createUsageStore(db)

  function list() {
    return db.select().from(quotas).all().map(toQuota)
  }

  function get(id: string) {
    const row = db.select().from(quotas).where(eq(quotas.id, id)).get()
    if (!row) throw apiError(404, 'QUOTA_NOT_FOUND', 'errors.quotaNotFound')
    return toQuota(row)
  }

  function validate(quota: Omit<QuotaT, 'id'>) {
    const { type, id } = quota.scope
    const exists = type === 'group' ? db.select().from(groups).where(eq(groups.id, id)).get()
      : type === 'person' ? db.select().from(people).where(eq(people.id, id)).get()
        : Mac.safeParse(id).success && db.select().from(clients).where(eq(clients.mac, id)).get()
    if (!exists) throw apiError(404, 'QUOTA_SCOPE_NOT_FOUND', 'errors.quotaScopeNotFound')
    if (quota.action.type === 'egress' && !db.select().from(egresses).where(eq(egresses.id, quota.action.egressId)).get()) {
      throw apiError(404, 'EGRESS_NOT_FOUND', 'errors.egressNotFound')
    }
  }

  function save(id: string, input: Partial<Omit<QuotaT, 'id'>>, create?: Omit<QuotaT, 'id'>) {
    const value = create ?? { ...get(id), ...input }
    validate(value)
    const { scope, ...fields } = value
    const row = { ...fields, id, scopeId: scope.id, scopeType: scope.type }
    db.insert(quotas).values(row).onConflictDoUpdate({ target: quotas.id, set: row }).run()
    engine.emit('event', { type: 'access.changed' })
    return get(id)
  }

  function evaluate(people: PersonT[], at: number, timezone: string, selected = list()): QuotaEvaluation[] {
    if (!selected.length) return []
    const periods = new Map(['daily', 'weekly', 'monthly'].map(period => [
      period, quotaPeriod(at, timezone, period as QuotaT['period']),
    ]))
    const approved = db.select().from(extensionRequests).where(eq(extensionRequests.status, 'approved')).all()
    const totals = new Map<string, ReturnType<typeof usage.forMacs>>()
    const evaluations: QuotaEvaluation[] = []
    for (const quota of selected) {
      const { start, end, day } = periods.get(quota.period)!
      const { scope } = quota
      const members = scope.type === 'person' ? people.filter(person => person.id === scope.id)
        : people.filter(person => person.groupIds.includes(scope.id))
      const subjects = scope.type === 'client'
        ? [{ personId: people.find(person => person.deviceMacs.includes(scope.id))?.id ?? null, macs: [scope.id] }]
        : members.map(person => ({ personId: person.id, macs: person.deviceMacs }))
      for (const { personId, macs } of subjects) {
        const key = JSON.stringify([start, end, macs])
        const consumed = totals.get(key) ?? usage.forMacs(macs, start, end)
        totals.set(key, consumed)
        const used = quota.metric === 'bytes' ? consumed.rxBytes + consumed.txBytes : consumed.activeMinutes
        const limit = (quota.period === 'daily' ? quota.weekdayLimits?.[day] : null) ?? quota.limit
        const bonus = !personId ? 0 : approved.filter(row => row.personId === personId && row.quotaId === quota.id
          && (row.periodStart === null ? row.decidedAt !== null && row.decidedAt >= start && row.decidedAt < end : row.periodStart === start && (row.expiresAt === null || row.expiresAt === end)))
          .reduce((sum, row) => Math.min(Number.MAX_VALUE, sum + (row.grantedAmount ?? row.amount)), 0)
        const pct = Math.min(Number.MAX_VALUE, used / (limit + bonus) * 100)
        const state = pct >= 100 ? 'exceeded' : pct >= quota.warnAtPct ? 'warning' : 'ok'
        const subject = personId ? `person:${personId}` : `client:${scope.id}`
        evaluations.push({ quota, personId, subject, macs, start,
          status: { quotaId: quota.id, name: quota.name, metric: quota.metric, period: quota.period,
            used, limit, bonus, pct, state, resetsAt: end } })
      }
    }
    return evaluations
  }

  function transitions(evaluations: QuotaEvaluation[]) {
    for (const { quota, status, personId, subject, start } of evaluations) {
      if (!quota.enabled) continue
      const row = db.select().from(quotaTransitions).where(and(
        eq(quotaTransitions.quotaId, quota.id), eq(quotaTransitions.subject, subject),
      )).get()
      const periodEnd = status.resetsAt
      const previous = row?.periodStart === start && row.periodEnd === periodEnd ? row : undefined
      if (previous?.state === status.state) continue
      const warned = status.state === 'warning' || previous?.warned === true
      const exceeded = status.state === 'exceeded' || previous?.exceeded === true
      const state = status.state
      db.insert(quotaTransitions).values({ quotaId: quota.id, subject, periodStart: start, periodEnd, state, warned, exceeded })
        .onConflictDoUpdate({ target: [quotaTransitions.quotaId, quotaTransitions.subject],
          set: { periodStart: start, periodEnd, state, warned, exceeded } }).run()
      const data = { personId, quotaId: quota.id }
      liveBus.emit({ type: 'quota', data: { ...data, state } })
      if (state === 'warning' && !previous?.warned) {
        engine.emit('event', { type: 'quota.warning', ...data })
        engine.emit('event', { type: 'notification', event: 'quota_warning', ...data })
      }
      if (state === 'exceeded' && !previous?.exceeded) {
        engine.emit('event', { type: 'quota.exceeded', ...data })
        engine.emit('event', { type: 'notification', event: 'quota_exceeded', ...data })
      }
    }
  }

  return {
    list, get, evaluate, transitions,
    create: (input: Omit<QuotaT, 'id'>) => save(randomUUID(), input, input),
    update: save,
    remove(id: string, at: number) {
      get(id)
      db.transaction(tx => {
        tx.update(extensionRequests).set({ status: 'expired', decidedAt: at }).where(and(
          eq(extensionRequests.quotaId, id), eq(extensionRequests.status, 'pending'),
        )).run()
        tx.delete(quotas).where(eq(quotas.id, id)).run()
      })
      engine.emit('event', { type: 'access.changed' })
      return { ok: true as const }
    },
  }
}
