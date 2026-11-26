import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { Id, Paged, Ts } from '#shared/schemas/common'
import { AuditEvent, AuditQuery, type AuditEventT } from '#shared/schemas/insight'
import { useDb } from '../db'
import { auditEvents } from '../db/schema'
import { apiError } from '../utils/api-error'
import { liveBus } from '../utils/bus'
import { isSecretKey, redactSecrets, REDACTED } from '../utils/redact'

type AuditInput = Omit<AuditEventT, 'id' | 'ts' | 'target' | 'messageParams' | 'diff' | 'dryRun'>
  & Partial<Pick<AuditEventT, 'target' | 'messageParams' | 'diff' | 'dryRun'>>

const PageOutput = Paged(AuditEvent)
const Cursor = z.tuple([Ts, Id])

function redactDiff(diff: AuditEventT['diff']): AuditEventT['diff'] {
  return diff?.map(change => {
    const secret = change.secret || change.path.split(/[.\[\]'"]+/).some(isSecretKey)
    return secret
      ? { ...change, before: REDACTED, after: REDACTED, beforeLabel: null, afterLabel: null, secret }
      : { ...change, before: redactSecrets(change.before), after: redactSecrets(change.after) }
  }) ?? null
}

function decodeCursor(cursor: string) {
  try {
    if (cursor.length > 512 || !/^[\da-z_-]+$/i.test(cursor)) throw new Error('Invalid encoding')
    return Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw apiError(400, 'INVALID_CURSOR', 'errors.invalidCursor')
  }
}

export function createAuditService(db = useDb(), bus = liveBus, now = Date.now) {
  function record(input: AuditInput) {
    const entry = AuditEvent.parse({
      ...input,
      id: randomUUID(),
      ts: now(),
      target: input.target ?? null,
      messageParams: redactSecrets(input.messageParams ?? {}),
      diff: redactDiff(input.diff ?? null),
      dryRun: input.dryRun ?? false,
    })
    const { actor, ...fields } = entry
    db.insert(auditEvents).values({
      ...fields, actorType: actor.type, actorId: actor.id, actorName: actor.name,
    }).run()
    bus.emit({ type: 'audit', data: entry })
    return entry
  }

  function list(input: z.input<typeof AuditQuery> = {}) {
    const query = AuditQuery.parse(input)
    const filters: (SQL | undefined)[] = []
    if (query.category) filters.push(eq(auditEvents.category, query.category))
    if (query.actor) filters.push(eq(auditEvents.actorType, query.actor))
    if (query.from !== undefined) filters.push(gte(auditEvents.ts, query.from))
    if (query.to !== undefined) filters.push(lte(auditEvents.ts, query.to))
    const search = query.q?.trim()
    if (search) {
      const term = search.toLowerCase()
      filters.push(or(...[
        auditEvents.action, auditEvents.actorName, auditEvents.actorId, auditEvents.category,
        auditEvents.messageKey, auditEvents.messageParams,
        sql`json_extract(${auditEvents.target}, '$.id')`,
        sql`json_extract(${auditEvents.target}, '$.label')`,
        sql`json_extract(${auditEvents.target}, '$.type')`,
      ].map(column => sql`instr(lower(${column}), ${term}) > 0`)))
    }
    if (query.cursor !== undefined) {
      const [ts, id] = decodeCursor(query.cursor)
      filters.push(or(lt(auditEvents.ts, ts), and(eq(auditEvents.ts, ts), lt(auditEvents.id, id))))
    }

    const rows = db.select().from(auditEvents).where(and(...filters))
      .orderBy(desc(auditEvents.ts), desc(auditEvents.id)).limit(query.limit + 1).all()
    const items = rows.slice(0, query.limit).map(({ actorType, actorName, actorId, ...entry }) => ({
      ...entry, actor: { type: actorType, name: actorName, id: actorId },
    }))
    const last = items.at(-1)
    const nextCursor = rows.length > query.limit && last
      ? Buffer.from(JSON.stringify([last.ts, last.id])).toString('base64url')
      : null
    return PageOutput.parse({ items, nextCursor })
  }

  return { record, list }
}

export function userActor(user: { id: string, username: string }): AuditEventT['actor'] {
  return { type: 'user', id: user.id, name: user.username }
}
