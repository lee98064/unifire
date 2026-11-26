import { useAccess } from '../../../services/controller-runtime'
import { accessId } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const access = await useAccess()
  access.people.get(id)
  return access.quotaStatuses(id).map(row => row.status)
})
