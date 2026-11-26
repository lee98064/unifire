import { z } from 'zod'
import { Id, Ts } from './common'

export const Role = z.enum(['admin', 'member'])
export const Locale = z.enum(['zh-TW', 'en'])

export const User = z.object({
  id: Id,
  username: z.string(),
  displayName: z.string(),
  role: Role,
  /** member accounts are bound to a Person (their devices / quotas). */
  personId: Id.nullable(),
  locale: Locale,
  hasPasskey: z.boolean(),
  createdAt: Ts,
  lastLoginAt: Ts.nullable(),
})

export const LoginInput = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

export const UserCreateInput = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: Role,
  personId: Id.nullable().default(null),
  locale: Locale.default('zh-TW'),
})

export const UserUpdateInput = UserCreateInput.partial().extend({
  password: z.string().min(8).max(256).optional(),
})

export const PasswordChangeInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
})

/** Session payload stored by nuxt-auth-utils (`user` field). */
export const SessionUser = User.pick({ id: true, username: true, displayName: true, role: true, personId: true, locale: true })

/** First-run state (GET /api/setup/status). */
export const SetupStatus = z.object({
  needsAdmin: z.boolean(),
  needsController: z.boolean(),
  ready: z.boolean(),
  mock: z.boolean(),
  version: z.string(),
})

export type UserT = z.infer<typeof User>
export type SessionUserT = z.infer<typeof SessionUser>
export type RoleT = z.infer<typeof Role>
export type LocaleT = z.infer<typeof Locale>
export type SetupStatusT = z.infer<typeof SetupStatus>
