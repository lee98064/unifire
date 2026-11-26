import { userActor } from '../../services/audit'
import { useAutomation } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

import { guestWifiWithProxyUrl } from '../../utils/proxy-origin'

export default adminControllerHandler(async (event, admin) => {
  return guestWifiWithProxyUrl(event, await (await useAutomation()).guestWifi.rotate({ actor: userActor(admin) }))
})
