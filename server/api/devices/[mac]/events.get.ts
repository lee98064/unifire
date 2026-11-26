import { z } from 'zod'
import { api } from '#shared/api'
import { Mac } from '#shared/schemas/common'
import { useInfra } from '../../../services/controller-runtime'
import { apiError, readApiParams, readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const { from, to } = await readApiQuery(event, api.deviceEvents.input as z.ZodType<{ from: number, to: number }>)
  if (from > to) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  return (await useInfra()).events(mac, from, to)
})
