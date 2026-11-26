import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useRouting } from '../services/controller-runtime'
import { readApiQuery } from '../utils/api-error'
import { adminControllerHandler } from '../utils/controller-api'

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, api.switchLog.input as ZodType<{ managedRouteId?: string, cursor?: string, limit: number }>)
  return (await useRouting()).managed.log(query)
})
