import { defineEventHandler } from 'h3'
import { Ok } from '#shared/schemas/common'
import { requireAny } from '../../utils/auth'

export default defineEventHandler(async event => {
  await requireAny(event)
  await clearUserSession(event)
  return Ok.parse({ ok: true })
})
