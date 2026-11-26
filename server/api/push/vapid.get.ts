import { defineEventHandler } from 'h3'
import { useAutomation } from '../../services/controller-runtime'
import { requireAny } from '../../utils/auth'

export default defineEventHandler(async event => {
  await requireAny(event)
  return (await useAutomation()).notifications.push.publicKey()
})
