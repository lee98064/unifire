import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { Id, Ok } from '#shared/schemas/common'
import { createUsersService } from '../../services/users'
import { readApiParams } from '../../utils/api-error'
import { recordUserChange, requireAdmin } from '../../utils/auth'

const UserParams = z.object({ id: Id })

export default defineEventHandler(async event => {
  const { id } = await readApiParams(event, UserParams)
  const actor = await requireAdmin(event)
  const user = createUsersService().remove(id)
  recordUserChange('userDeleted', actor, user)
  return Ok.parse({ ok: true })
})
