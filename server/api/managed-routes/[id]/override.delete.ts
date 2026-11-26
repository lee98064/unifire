import { userActor } from '../../../services/audit'
import { useRouting } from '../../../services/controller-runtime'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async (event, admin) => {
  const id = await routingId(event)
  return (await useRouting()).managed.override(id, null, { actor: userActor(admin) })
})
