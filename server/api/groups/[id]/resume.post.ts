import { useAccess } from '../../../services/controller-runtime'
import { accessId } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  return (await useAccess()).people.groupPause(id, null)
})
