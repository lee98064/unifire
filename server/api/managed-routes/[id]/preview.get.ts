import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useRouting } from '../../../services/controller-runtime'
import { readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async event => {
  const id = await routingId(event)
  const { hours } = await readApiQuery(event, api.managedRoutePreview.input as ZodType<{ hours: number }>)
  return (await useRouting()).managed.preview(id, hours)
})
