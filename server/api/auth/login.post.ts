import { defineEventHandler } from 'h3'
import { LoginInput } from '#shared/schemas/auth'
import { createLoginLimiter } from '../../services/login-limit'
import { createUsersService } from '../../services/users'
import { apiError, readApiBody } from '../../utils/api-error'
import { checkLoginLimit, completeLogin, recordLoginFailure, verifyLoginPassword } from '../../utils/auth'

const limiter = createLoginLimiter()

export default defineEventHandler(async event => {
  const { username, password } = await readApiBody(event, LoginInput)
  checkLoginLimit(event, limiter, username)
  const service = createUsersService()
  const user = service.findByUsername(username)
  if (await verifyLoginPassword(password, user) && user) {
    const updated = service.markLogin(user.id, user.authVersion)
    if (updated) return completeLogin(event, updated, 'password')
  }

  recordLoginFailure('password')
  throw apiError(401, 'INVALID_CREDENTIALS', 'errors.invalidCredentials')
})
