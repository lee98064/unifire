import { defineEventHandler } from 'h3'
import { createUsersService } from '../../services/users'
import { requireAny } from '../../utils/auth'

export default defineEventHandler(async event => {
  const user = await requireAny(event)
  return createUsersService().get(user.id)
})
