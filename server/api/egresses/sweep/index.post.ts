import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { userActor } from '../../../services/audit'
import { useRouting } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { egressIds } = await readApiBody(event, api.sweepStart.input as ZodType<{ egressIds?: string[] }>)
  return (await useRouting()).sweep.start(egressIds, { actor: userActor(admin) })
})
