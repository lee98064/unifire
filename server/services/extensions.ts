import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { ExtensionDecisionInput, ExtensionRequestInput, ExtensionRequestT, QuotaT } from '#shared/schemas/access'
import type { Db } from '../db'
import { extensionRequests, quotas } from '../db/schema'
import { quotaPeriod } from '../engine/access-time'
import { apiError } from '../utils/api-error'
import { liveBus } from '../utils/bus'
import type { EngineEvents } from '../unifi/ws'
import { createAuditService, userActor } from './audit'
import { grantAllowance, type createPeopleService } from './people'
import type { createQuotaService } from './quotas'

type Row = typeof extensionRequests.$inferSelect
function toRequest(row: Row): ExtensionRequestT {
  const { id, personId, quotaId, amount, grantedAmount, reason, status, createdAt, decidedAt, decidedBy } = row
  return { id, personId, quotaId, amount: grantedAmount ?? amount, reason, status, createdAt, decidedAt, decidedBy }
}

export function createExtensions(db: Db, engine: EngineEvents, people: ReturnType<typeof createPeopleService>,
  quotaService: ReturnType<typeof createQuotaService>, timezone: () => string, now = Date.now) {
  const audit = createAuditService(db)
  const changed = (row: { id: string, personId: string }) =>
    liveBus.emit({ type: 'extension.request', data: { requestId: row.id, personId: row.personId } })

  function allows(personId: string, quota: QuotaT) {
    const person = people.get(personId)
    const { type, id } = quota.scope
    return quota.enabled && (type === 'person' ? person.id === id
      : type === 'group' ? person.groupIds.includes(id) : person.deviceMacs.includes(id))
  }

  function expire(at = now(), personId?: string) {
    const pending = db.select().from(extensionRequests).where(and(eq(extensionRequests.status, 'pending'),
      personId ? eq(extensionRequests.personId, personId) : undefined)).all()
    if (!pending.length) return
    const zone = timezone()
    for (const row of pending) {
      const quota = row.quotaId ? db.select().from(quotas).where(eq(quotas.id, row.quotaId)).get() : undefined
      const period = quotaPeriod(at, zone, quota?.period ?? 'daily')
      const expiresAt = row.expiresAt ?? quotaPeriod(row.createdAt, zone, quota?.period ?? 'daily').end
      if (at < expiresAt && (row.periodStart === null || row.periodStart === period.start && expiresAt === period.end)
        && (!quota || allows(row.personId, { ...quota, scope: { type: quota.scopeType, id: quota.scopeId } }))) continue
      db.update(extensionRequests).set({ status: 'expired', decidedAt: at }).where(eq(extensionRequests.id, row.id)).run()
      changed(row)
    }
  }

  function list(status?: ExtensionRequestT['status'], personId?: string) {
    expire(now(), personId)
    return db.select().from(extensionRequests).where(and(
      status ? eq(extensionRequests.status, status) : undefined,
      personId ? eq(extensionRequests.personId, personId) : undefined,
    )).orderBy(desc(extensionRequests.createdAt), desc(extensionRequests.id)).all().map(toRequest)
  }

  function create(personId: string | null, input: z.output<typeof ExtensionRequestInput>) {
    if (!personId) throw apiError(403, 'MEMBER_UNBOUND', 'errors.memberUnbound')
    people.get(personId)
    const at = now()
    expire(at, personId)
    const quota = input.quotaId ? quotaService.list().find(item => item.id === input.quotaId) : undefined
    if (input.quotaId && (!quota || !allows(personId, quota))) throw apiError(404, 'QUOTA_NOT_FOUND', 'errors.quotaNotFound')
    const { start, end } = quotaPeriod(at, timezone(), quota?.period ?? 'daily')
    const request = db.transaction(tx => {
      if (tx.select().from(extensionRequests).where(and(eq(extensionRequests.personId, personId),
        eq(extensionRequests.status, 'pending'))).get()) throw apiError(409, 'REQUEST_PENDING', 'errors.requestPending')
      return tx.insert(extensionRequests).values({ ...input, id: randomUUID(), personId, createdAt: at, periodStart: start, expiresAt: end })
        .returning().get()
    })
    changed(request)
    engine.emit('event', { type: 'notification', event: 'extension_request', requestId: request.id, personId })
    return toRequest(request)
  }

  function decide(id: string, input: z.output<typeof ExtensionDecisionInput>, admin: { id: string, username: string }) {
    const at = now()
    expire(at)
    const updated = db.transaction(tx => {
      const row = tx.select().from(extensionRequests).where(eq(extensionRequests.id, id)).get()
      if (!row) throw apiError(404, 'REQUEST_NOT_FOUND', 'errors.requestNotFound')
      if (row.status !== 'pending') throw apiError(409, 'REQUEST_NOT_PENDING', 'errors.requestNotPending')
      const approved = input.decision === 'approve'
      const amount = input.amount ?? row.amount
      if (approved && !row.quotaId) grantAllowance(tx, row.personId, amount, at)
      return tx.update(extensionRequests).set({ status: approved ? 'approved' : 'denied', decidedAt: at, decidedBy: admin.id,
        grantedAmount: approved ? amount : null }).where(eq(extensionRequests.id, id)).returning().get()
    })
    const person = people.get(updated.personId).name
    const minutes = updated.grantedAmount ?? updated.amount
    audit.record({ actor: userActor(admin), category: 'quota', action: `extension.${updated.status}`, severity: 'success',
      messageKey: updated.status === 'approved' ? 'audit.extension.approved' : 'audit.extension.denied',
      messageParams: { requestId: id, person, minutes: String(minutes) }, target: { type: 'extension', id, label: person } })
    changed(updated)
    engine.emit('event', { type: 'notification', event: 'extension_request', variant: 'extension_decided',
      requestId: id, personId: updated.personId, minutes, status: updated.status })
    people.changed([updated.personId])
    return toRequest(updated)
  }

  return { list, create, decide, expire }
}
