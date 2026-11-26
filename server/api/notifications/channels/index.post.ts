import { NotificationChannelInput } from '#shared/schemas/system'
import { useAutomation } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const input = await readApiBody(event, NotificationChannelInput)
  return (await useAutomation()).notifications.channels.create(input)
})
