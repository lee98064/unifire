import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from '~~/server/db'
import { people } from '~~/server/db/schema'
import { createLoginLimiter } from '~~/server/services/login-limit'
import { createChallengeStore, createPasskeysService } from '~~/server/services/passkeys'
import { createUsersService } from '~~/server/services/users'

let connection: ReturnType<typeof createDatabase>
beforeEach(() => { connection = createDatabase() })
afterEach(() => { connection.sqlite.close() })

const account = {
  username: 'HouseAdmin', displayName: 'Admin', passwordHash: 'test-hash',
  role: 'admin' as const, personId: null, locale: 'en' as const,
}

describe('users and passkeys', () => {
  it('claims setup once, prevents loss of the last admin, and preserves omitted fields', () => {
    const users = createUsersService(connection.db)
    expect(users.adminCount()).toBe(0)
    const admin = users.create(account, true)
    expect(() => users.create(account, true)).toThrow(expect.objectContaining({ data: { code: 'SETUP_COMPLETE' } }))
    expect(() => users.remove(admin.id)).toThrow(expect.objectContaining({ data: { code: 'LAST_ADMIN' } }))
    expect(() => users.update(admin.id, { role: 'member' })).toThrow(expect.objectContaining({ data: { code: 'LAST_ADMIN' } }))
    expect(() => users.create({ ...account, username: account.username.toLowerCase() }))
      .toThrow(expect.objectContaining({ data: { code: 'USERNAME_TAKEN' } }))
    connection.db.insert(people).values({ id: 'p1', name: 'Person', avatar: 'P', color: '#000000', createdAt: 123 }).run()
    const secondary = users.create({ ...account, username: 'another', personId: 'p1' })
    const member = users.update(secondary.id, { role: 'member', displayName: 'Member' })
    expect(member).toMatchObject({ role: 'member', personId: 'p1', locale: 'en' })
    expect(users.findByUsername('houseadmin')?.id).toBe(admin.id)
    expect(users.list()).toHaveLength(2)
    expect(users.remove(member.id).id).toBe(member.id)
  })

  it('rejects a stale password operation and increments the session version on a password change', () => {
    const users = createUsersService(connection.db)
    const created = users.create(account, true)
    const row = users.find(created.id)!
    const updated = users.changePassword(row, 'another-hash')
    expect(updated.authVersion).toBe(row.authVersion + 1)
    expect(users.markLogin(row.id, row.authVersion)).toBeUndefined()
    expect(() => users.changePassword(row, 'stale-hash')).toThrow(expect.objectContaining({ data: { code: 'USER_CHANGED' } }))
  })

  it('tracks passkey existence and accepts a counter change only from the observed counter', () => {
    const users = createUsersService(connection.db)
    const passkeys = createPasskeysService(connection.db)
    const user = users.create(account, true)
    const credential = { id: 'credential', publicKey: 'key', counter: 0, backedUp: false }
    expect(user.hasPasskey).toBe(false)
    expect(passkeys.register(user.id, credential)).toBe(true)
    expect(passkeys.register(user.id, credential)).toBe(false)
    expect(users.get(user.id).hasPasskey).toBe(true)
    const stored = passkeys.find(credential.id)!
    expect(passkeys.markUsed(stored, 1, true)).toBe(true)
    expect(passkeys.markUsed(stored, 1, true)).toBe(false)
  })
})

describe('rate limits and WebAuthn challenges', () => {
  it('enforces case-insensitive username limits across IPs and per-IP limits across usernames', () => {
    let now = 0
    const limiter = createLoginLimiter(() => now)
    for (let i = 0; i < 5; i++) expect(limiter.take(`ip-${i}`, 'Alice')).toBe(0)
    expect(limiter.take('other-ip', 'ALICE')).toBe(900_000)
    for (let i = 0; i < 10; i++) expect(limiter.take('shared-ip', `unique-${i}`)).toBe(0)
    expect(limiter.take('shared-ip', 'unique-more')).toBe(900_000)
    now = 899_999
    expect(limiter.take('other-ip', 'aLiCe')).toBe(1)
    now++
    expect(limiter.take('other-ip', 'Alice')).toBe(0)
    expect(limiter.take('shared-ip', 'unique-more')).toBe(0)
  })

  it('binds challenges to a scope, expires them, and consumes each one once', () => {
    let now = 0
    const challenges = createChallengeStore(() => now)
    challenges.store('first', 'challenge', 'account')
    expect(() => challenges.consume('first', 'another')).toThrow()
    expect(challenges.consume('first', 'account')).toBe('challenge')
    expect(() => challenges.consume('first', 'account')).toThrow()
    challenges.store('second', 'short-lived', 'account')
    now = 5 * 60_000
    expect(() => challenges.consume('second', 'account')).toThrow()
  })
})
