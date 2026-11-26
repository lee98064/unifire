import { useAutomation } from '../../../../services/controller-runtime'
import { accessId } from '../../../../utils/access-api'
import { adminControllerHandler } from '../../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const id = await accessId(event)
  return (await useAutomation()).notifications.test(id, admin.id)
})
