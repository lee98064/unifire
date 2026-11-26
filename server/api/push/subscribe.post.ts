import { PushSubscriptionInput } from '#shared/schemas/system'
import { defineEventHandler } from 'h3'
import { useAutomation } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { requireAny } from '../../utils/auth'

export default defineEventHandler(async event => {
  const user = await requireAny(event)
  const input = await readApiBody(event, PushSubscriptionInput)
  return (await useAutomation()).notifications.push.subscribe(user.id, input)
})
