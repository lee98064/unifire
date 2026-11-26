import { ManagedRouteCreateInput } from '#shared/schemas/routes'
import { userActor } from '../../services/audit'
import { useRouting } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const input = await readApiBody(event, ManagedRouteCreateInput)
  return (await useRouting()).managed.create(input, { actor: userActor(admin) })
})
