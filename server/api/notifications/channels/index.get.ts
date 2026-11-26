import { useAutomation } from '../../../services/controller-runtime'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async () => {
  return (await useAutomation()).notifications.channels.list()
})
