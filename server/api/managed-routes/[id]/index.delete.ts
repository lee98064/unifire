import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { userActor } from '../../../services/audit'
import { useRouting } from '../../../services/controller-runtime'
import { readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async (event, admin) => {
  const id = await routingId(event)
  const { deleteFromUnifi } = await readApiQuery(event, api.managedRouteRelease.input as ZodType<{ deleteFromUnifi: boolean }>)
  return (await useRouting()).managed.release(id, deleteFromUnifi, { actor: userActor(admin) })
})
