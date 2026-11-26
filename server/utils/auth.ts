import { randomBytes } from 'node:crypto'
import { getRequestIP, setResponseHeader, type H3Event } from 'h3'
import { getRequestIP as getPortableIP, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { SessionUser } from '#shared/schemas/auth'
import { createAuditService, userActor } from '../services/audit'
import { createLoginLimiter } from '../services/login-limit'
import { createUsersService } from '../services/users'
import { apiError } from './api-error'

import type {} from '../types/auth'

const secureSession = z.object({ authVersion: z.number().int().nonnegative(), expiresAt: z.number().int().positive() })

type UsersService = ReturnType<typeof createUsersService>
type UserRow = NonNullable<ReturnType<UsersService['find']>>

export function activeSessionUser(session: Awaited<ReturnType<typeof getUserSession>>, service = createUsersService()) {
  const payload = SessionUser.safeParse(session.user)
  if (!payload.success) return
  const secure = secureSession.safeParse(session.secure)
  if (!secure.success || secure.data.expiresAt <= Date.now()) return
  const row = service.find(payload.data.id)
  if (row && row.authVersion === secure.data.authVersion) return row
}

function setNoStore(event: H3Event | RequestEvent) {
  if ('node' in event) setResponseHeader(event, 'Cache-Control', 'no-store')
  else event.res.headers.set('Cache-Control', 'no-store')
}

export async function requireAccount(event: H3Event | RequestEvent) {
  setNoStore(event)
  const session = await getUserSession(event)
  const user = activeSessionUser(session)
  if (!user) throw apiError(401, 'AUTH_REQUIRED', 'errors.authRequired')
  return { row: user, user: SessionUser.parse(user), session }
}

export async function requireAny(event: H3Event) {
  return (await requireAccount(event)).user
}

export async function requireAdmin(event: H3Event) {
  const user = await requireAny(event)
  assertAdmin(user)
  return user
}

function assertAdmin(user: { role: 'admin' | 'member' }) {
  if (user.role !== 'admin') throw apiError(403, 'FORBIDDEN', 'errors.forbidden')
}

export async function requireMember(event: H3Event) {
  const user = await requireAny(event)
  if (user.role === 'member' && !user.personId) {
    throw apiError(403, 'MEMBER_UNBOUND', 'errors.memberUnbound')
  }
  return { user, personId: user.personId }
}

export async function startUserSession(event: H3Event | RequestEvent, user: UserRow) {
  await clearUserSession(event)
  const maxAge = useRuntimeConfig().session.maxAge ?? 30 * 24 * 60 * 60
  const expiresAt = Date.now() + maxAge * 1000
  await replaceUserSession(event, {
    user: SessionUser.parse(user),
    secure: { authVersion: user.authVersion, expiresAt },
  })
  setNoStore(event)
}

export function checkLoginLimit(event: H3Event | RequestEvent, limiter: ReturnType<typeof createLoginLimiter>, username?: string) {
  const ip = 'node' in event ? getRequestIP(event) : getPortableIP(event)
  const retryAfterMs = limiter.take(ip ?? 'unknown', username)
  if (retryAfterMs > 0) {
    const seconds = Math.ceil(retryAfterMs / 1000)
    if ('node' in event) setResponseHeader(event, 'Retry-After', seconds)
    else event.res.headers.set('Retry-After', seconds.toString())
    throw apiError(429, 'LOGIN_RATE_LIMITED', 'errors.loginRateLimited')
  }
}

let dummyHash: Promise<string> | undefined

export async function verifyLoginPassword(password: string, user: UserRow | undefined) {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'))
  const fallback = await dummyHash
  return await verifyPassword(user?.passwordHash ?? fallback, password) && !!user
}

export function recordLoginFailure(method: 'password' | 'passkey') {
  createAuditService().record({
    actor: { type: 'system', id: null, name: null },
    category: 'auth',
    action: 'auth.loginFailed',
    severity: 'warning',
    messageKey: 'audit.auth.loginFailed',
    messageParams: { method },
  })
}

export async function completeLogin(event: H3Event | RequestEvent, user: UserRow, method: 'password' | 'passkey') {
  await startUserSession(event, user)
  createAuditService().record({
    actor: userActor(user), category: 'auth', action: 'auth.login', severity: 'success',
    messageKey: 'audit.auth.login', messageParams: { username: user.username, method },
  })
  return createUsersService().get(user.id)
}

export function recordUserChange(action: 'userCreated' | 'userUpdated' | 'userDeleted' | 'passwordChanged',
  actor: { id: string, username: string }, target = actor) {
  createAuditService().record({
    actor: userActor(actor), category: 'auth', action: `auth.${action}`, severity: 'success',
    target: { type: 'user', id: target.id, label: target.username },
    messageKey: `audit.auth.${action}`, messageParams: { username: target.username },
  })
}
