import { OverrideInput } from '#shared/schemas/routes'
import { userActor } from '../../../services/audit'
import { useRouting } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async (event, admin) => {
  const id = await routingId(event)
  const input = await readApiBody(event, OverrideInput)
  return (await useRouting()).managed.override(id, input, { actor: userActor(admin) })
})
