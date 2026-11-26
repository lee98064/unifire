import { z } from 'zod'
import { defineEventHandler } from 'h3'
import { useAutomation } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { requireAny } from '../../utils/auth'

export default defineEventHandler(async event => {
  const user = await requireAny(event)
  const { endpoint } = await readApiBody(event, z.object({ endpoint: z.string() }))
  return (await useAutomation()).notifications.push.unsubscribe(user.id, endpoint)
})
