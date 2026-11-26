import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useSnapshots } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, api.snapshots.input as ZodType<{ cursor?: string, limit: number }>)
  return api.snapshots.output.parse((await useSnapshots()).list(query))
})
