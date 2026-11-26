import { GuestWifiInput } from '#shared/schemas/automation'
import { useAutomation } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

import { guestWifiWithProxyUrl } from '../../utils/proxy-origin'

export default adminControllerHandler(async event => {
  const input = await readApiBody(event, GuestWifiInput)
  return guestWifiWithProxyUrl(event, await (await useAutomation()).guestWifi.save(input))
})
