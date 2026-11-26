import { useAccess } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { z } from 'zod'
import { Ts } from '#shared/schemas/common'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { from, to } = await readApiQuery(event, z.object({ from: z.coerce.number().pipe(Ts), to: z.coerce.number().pipe(Ts) }))
  return (await useAccess()).people.timeline(from, to)
})
