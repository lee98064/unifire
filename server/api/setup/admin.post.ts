import { defineEventHandler } from 'h3'
import { UserCreateInput } from '#shared/schemas/auth'
import { createUsersService } from '../../services/users'
import { apiError, readApiBody } from '../../utils/api-error'
import { recordUserChange, startUserSession } from '../../utils/auth'

const SetupAdmin = UserCreateInput.omit({ role: true, personId: true })

export default defineEventHandler(async event => {
  const { password, ...input } = await readApiBody(event, SetupAdmin)
  const service = createUsersService()
  if (service.adminCount() !== 0) throw apiError(409, 'SETUP_COMPLETE', 'errors.setupComplete')
  const user = service.create({ ...input, passwordHash: await hashPassword(password), role: 'admin', personId: null }, true)
  recordUserChange('userCreated', user)
  const row = service.find(user.id)
  if (!row) throw apiError(404, 'USER_NOT_FOUND', 'errors.userNotFound')
  await startUserSession(event, row)
  return user
})
