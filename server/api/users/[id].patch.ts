import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { Locale, UserUpdateInput } from '#shared/schemas/auth'
import { Id } from '#shared/schemas/common'
import { createUsersService } from '../../services/users'
import { readApiBody, readApiParams } from '../../utils/api-error'
import { recordUserChange, requireAdmin } from '../../utils/auth'

const UserParams = z.object({ id: Id })
// The create schema supplies defaults. PATCH must update only fields sent by the client.
const UserPatch = UserUpdateInput.extend({ personId: Id.nullable().optional(), locale: Locale.optional() })

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const { id } = await readApiParams(event, UserParams)
  const { password, ...input } = await readApiBody(event, UserPatch)
  const passwordHash = password === undefined ? undefined : await hashPassword(password)
  const actor = await requireAdmin(event)
  const user = createUsersService().update(id, { ...input, passwordHash })
  recordUserChange('userUpdated', actor, user)
  if (passwordHash !== undefined) recordUserChange('passwordChanged', actor, user)
  return user
})
