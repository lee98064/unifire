import { defineEventHandler } from 'h3'
import { UserCreateInput } from '#shared/schemas/auth'
import { createUsersService } from '../../services/users'
import { readApiBody } from '../../utils/api-error'
import { recordUserChange, requireAdmin } from '../../utils/auth'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const { password, ...input } = await readApiBody(event, UserCreateInput)
  const passwordHash = await hashPassword(password)
  const actor = await requireAdmin(event)
  const user = createUsersService().create({ ...input, passwordHash })
  recordUserChange('userCreated', actor, user)
  return user
})
