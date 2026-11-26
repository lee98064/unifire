import { defineEventHandler } from 'h3'
import { createUsersService } from '../../services/users'
import { requireAdmin } from '../../utils/auth'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return createUsersService().list()
})
