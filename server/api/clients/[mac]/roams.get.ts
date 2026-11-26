import { z } from 'zod'
import { api } from '#shared/api'
import { Mac, Ts } from '#shared/schemas/common'
import { useAccess } from '../../../services/controller-runtime'
import { readApiParams, readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

const query = api.clientRoams.input!.pipe(z.object({ from: Ts, to: Ts }).refine(range => range.from <= range.to))

export default adminControllerHandler(async event => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const { from, to } = await readApiQuery(event, query)
  return (await useAccess()).roams(mac, from, to)
})
