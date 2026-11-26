import { afterEach, describe, expect, it } from 'vitest'
import type { LiveEventT } from '#shared/schemas/system'
import { createDatabase } from '~~/server/db'
import { createAuditService } from '~~/server/services/audit'
import { canReceiveEvent, createLiveBus } from '~~/server/utils/bus'

const closes: (() => void)[] = []
afterEach(() => closes.splice(0).forEach(close => close()))
const actor = { type: 'user' as const, id: 'user-1', name: 'Alice' }
const entry = {
  actor, category: 'config' as const, action: 'config.changed',
  severity: 'info' as const, messageKey: 'audit.test',
}

function setup() {
  const { db, sqlite } = createDatabase()
  closes.push(() => sqlite.close())
  const bus = createLiveBus()
  let ts = 0
  return { bus, audit: createAuditService(db, bus, () => ts), setTime: (time: number) => { ts = time } }
}

describe('audit', () => {
  it('paginates tied timestamps with a stable cursor and applies all filters', () => {
    const { audit, setTime } = setup()
    const older = audit.record({ ...entry, category: 'auth' })
    setTime(10)
    const first = audit.record({ ...entry, target: { id: 'r1', type: 'route', label: 'WAN 100%' } })
    const second = audit.record({ ...entry, target: { id: 'r2', type: 'route', label: 'WAN 200%' } })
    setTime(11)
    const newest = audit.record({ ...entry, actor: { type: 'system', id: null, name: null } })
    const one = audit.list({ limit: 2 })
    const two = audit.list({ limit: 2, cursor: one.nextCursor! })
    expect(one.items[0]?.id).toBe(newest.id)
    expect(two.items[1]?.id).toBe(older.id)
    expect(two.nextCursor).toBeNull()
    expect([one.items[1]?.id, two.items[0]?.id].sort()).toEqual([first.id, second.id].sort())
    expect(audit.list({ q: 'wan 100%', actor: 'user', category: 'config', from: 10, to: 10 }).items).toEqual([first])
    expect(audit.list({ q: 'w_n' }).items).toEqual([])
    expect(() => audit.list({ cursor: 'not a cursor' })).toThrow(expect.objectContaining({ data: { code: 'INVALID_CURSOR' } }))
  })

  it('redacts secrets before storage and emission', () => {
    const { audit, bus } = setup()
    const events: LiveEventT[] = []
    const unsubscribe = bus.subscribe(event => events.push(event))
    const first = audit.record({
      ...entry,
      messageParams: { token: 'sample-credential', name: 'visible' },
      diff: [{
        path: 'vpn.x_password', before: 'sample-credential', after: 'sample-credential',
        beforeLabel: 'sample-credential', afterLabel: 'sample-credential', secret: false,
      }, {
        path: 'obj', before: null, after: { wireguard_private_key: 'sample-credential', untouched: 'visible' },
        beforeLabel: null, afterLabel: null, secret: false,
      }],
    })
    unsubscribe()
    audit.record(entry)
    expect(events).toEqual([{ type: 'audit', data: first }])
    expect(JSON.stringify(first)).not.toContain('sample-credential')
    expect(first.diff?.[1]?.after).toEqual({ wireguard_private_key: '[redacted]', untouched: 'visible' })
    expect(audit.list().items).toContainEqual(first)
  })
})

describe('member event visibility', () => {
  it('permits only scoped personal events and hello', () => {
    const { audit } = setup()
    const member = { role: 'member', personId: 'p1' } as const
    const admin = { role: 'admin', personId: null } as const
    const auditEvent = { type: 'audit', data: audit.record(entry) } as const
    expect(canReceiveEvent(member, { type: 'hello', data: { ts: 0 } })).toBe(true)
    expect(canReceiveEvent(member, { type: 'presence', data: { personId: 'p1', home: true } })).toBe(true)
    expect(canReceiveEvent(member, { type: 'presence', data: { personId: 'p2', home: true } })).toBe(false)
    expect(canReceiveEvent(member, { type: 'extension.request', data: { personId: 'p1', requestId: 'r' } })).toBe(true)
    expect(canReceiveEvent(member, { type: 'quota', data: { personId: null, quotaId: 'q', state: 'ok' } })).toBe(false)
    expect(canReceiveEvent({ ...member, personId: null }, { type: 'presence', data: { personId: 'p1', home: true } })).toBe(false)
    expect(canReceiveEvent(member, auditEvent)).toBe(false)
    expect(canReceiveEvent(admin, auditEvent)).toBe(true)
  })
})
