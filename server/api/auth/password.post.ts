import { defineEventHandler } from 'h3'
import { PasswordChangeInput } from '#shared/schemas/auth'
import { Ok } from '#shared/schemas/common'
import { createUsersService } from '../../services/users'
import { apiError, readApiBody } from '../../utils/api-error'
import { recordUserChange, requireAccount, startUserSession } from '../../utils/auth'

export default defineEventHandler(async event => {
  const { row } = await requireAccount(event)
  const { currentPassword, newPassword } = await readApiBody(event, PasswordChangeInput)
  if (currentPassword.length > 256 || !await verifyPassword(row.passwordHash, currentPassword)) {
    throw apiError(401, 'INVALID_CREDENTIALS', 'errors.invalidCredentials')
  }
  const updated = createUsersService().changePassword(row, await hashPassword(newPassword))
  recordUserChange('passwordChanged', updated)
  await startUserSession(event, updated)
  return Ok.parse({ ok: true })
})
