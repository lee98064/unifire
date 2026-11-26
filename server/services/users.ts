import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, exists, sql } from 'drizzle-orm'
import { z } from 'zod'
import { User, UserCreateInput, UserUpdateInput, type UserT } from '#shared/schemas/auth'
import { useDb } from '../db'
import { passkeys, people, users } from '../db/schema'
import { apiError } from '../utils/api-error'

type UserRow = typeof users.$inferSelect
export type UserUpdate = z.infer<typeof UserUpdateInput>
type NewUser = Omit<z.infer<typeof UserCreateInput>, 'password'> & { passwordHash: string }

export function createUsersService(db = useDb()) {
  const identity = db.select({ one: sql`1` }).from(passkeys).where(eq(passkeys.userId, users.id))
  const publicRows = () => db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    role: users.role,
    personId: users.personId,
    locale: users.locale,
    hasPasskey: sql<boolean>`${exists(identity)}`.mapWith(Boolean),
    createdAt: users.createdAt,
    lastLoginAt: users.lastLoginAt,
  }).from(users)

  function find(id: string) {
    return db.select().from(users).where(eq(users.id, id)).get()
  }

  function findByUsername(username: string) {
    return db.select().from(users).where(sql`lower(${users.username}) = ${username.toLowerCase()}`).get()
  }

  function get(id: string): UserT {
    const row = publicRows().where(eq(users.id, id)).get()
    if (!row) throw apiError(404, 'USER_NOT_FOUND', 'errors.userNotFound')
    return User.parse(row)
  }

  function list() {
    return z.array(User).parse(publicRows().orderBy(asc(users.username), asc(users.id)).all())
  }

  function adminCount() {
    return db.select({ value: count() }).from(users).where(eq(users.role, 'admin')).get()?.value ?? 0
  }

  function checkBindings(input: { username?: string, personId?: string | null }, currentId?: string) {
    if (input.username !== undefined) {
      const existing = findByUsername(input.username)
      if (existing && existing.id !== currentId) {
        throw apiError(409, 'USERNAME_TAKEN', 'errors.usernameTaken')
      }
    }
    if (input.personId != null && !db.select({ id: people.id }).from(people).where(eq(people.id, input.personId)).get()) {
      throw apiError(400, 'PERSON_NOT_FOUND', 'errors.personNotFound')
    }
  }

  function create(input: NewUser, setup = false) {
    return db.transaction(() => {
      if (setup && adminCount() !== 0) throw apiError(409, 'SETUP_COMPLETE', 'errors.setupComplete')
      const id = randomUUID()
      const now = Date.now()
      const row = setup ? { ...input, role: 'admin' as const, personId: null } : input
      checkBindings(row)
      db.insert(users).values({ ...row, id, createdAt: now, lastLoginAt: setup ? now : null }).run()
      return get(id)
    }, { behavior: 'immediate' })
  }

  function protectLastAdmin(user: UserRow) {
    if (user.role === 'admin' && adminCount() <= 1) {
      throw apiError(409, 'LAST_ADMIN', 'errors.lastAdmin')
    }
  }

  function update(id: string, input: Omit<UserUpdate, 'password'> & { passwordHash?: string }) {
    return db.transaction(() => {
      const user = find(id)
      if (!user) throw apiError(404, 'USER_NOT_FOUND', 'errors.userNotFound')
      if (input.role === 'member') protectLastAdmin(user)
      checkBindings(input, id)
      const { passwordHash, ...fields } = input
      const patch = { ...fields, ...(passwordHash === undefined ? {} : {
        passwordHash, authVersion: user.authVersion + 1,
      }) }
      if (Object.values(patch).some(value => value !== undefined)) {
        db.update(users).set(patch).where(eq(users.id, id)).run()
      }
      return get(id)
    }, { behavior: 'immediate' })
  }

  function remove(id: string) {
    return db.transaction(() => {
      const user = find(id)
      if (!user) throw apiError(404, 'USER_NOT_FOUND', 'errors.userNotFound')
      protectLastAdmin(user)
      db.delete(users).where(eq(users.id, id)).run()
      return User.parse({ ...user, hasPasskey: false })
    }, { behavior: 'immediate' })
  }

  function changePassword(user: UserRow, passwordHash: string) {
    const updated = db.update(users).set({
      passwordHash,
      authVersion: user.authVersion + 1,
    }).where(and(eq(users.id, user.id), eq(users.authVersion, user.authVersion))).returning().get()
    if (!updated) throw apiError(409, 'USER_CHANGED', 'errors.userChanged')
    return updated
  }

  function markLogin(id: string, authVersion: number) {
    return db.update(users).set({ lastLoginAt: Date.now() })
      .where(and(eq(users.id, id), eq(users.authVersion, authVersion))).returning().get()
  }

  return { find, findByUsername, get, list, adminCount, create, update, remove, changePassword, markLogin }
}
