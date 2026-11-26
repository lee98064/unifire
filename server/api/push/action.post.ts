import { z } from 'zod'
import { defineEventHandler } from 'h3'
import { useAutomation } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'

export default defineEventHandler(async event => {
  const { token } = await readApiBody(event, z.object({ token: z.string() }))
  return (await useAutomation()).notifications.push.execute(token)
})
