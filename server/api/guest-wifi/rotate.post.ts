import { userActor } from '../../services/audit'
import { useAutomation } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  return (await useAutomation()).guestWifi.rotate({ actor: userActor(admin) })
})
