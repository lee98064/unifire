import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useSnapshots } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { from, to } = await readApiQuery(event, api.snapshotDiff.input as ZodType<{ from: string, to?: string }>)
  return (await useSnapshots()).diff(from, to)
})
