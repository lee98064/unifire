import { NotificationChannelInput } from '#shared/schemas/system'
import { useAutomation } from '../../../../services/controller-runtime'
import { accessId, readAccessPatch } from '../../../../utils/access-api'
import { adminControllerHandler } from '../../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const input = await readAccessPatch(event, NotificationChannelInput.partial())
  return (await useAutomation()).notifications.channels.update(id, input)
})
