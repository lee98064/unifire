import { z } from 'zod'
import { Mac } from '#shared/schemas/common'
import { SeriesRange } from '#shared/schemas/infra'
import { useInfra } from '../../../../services/controller-runtime'
import { readApiParams, readApiQuery } from '../../../../utils/api-error'
import { adminControllerHandler } from '../../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { mac, idx } = await readApiParams(event, z.object({ mac: Mac, idx: z.coerce.number().int().min(1) }))
  const { range } = await readApiQuery(event, z.object({ range: SeriesRange.default('24h') }))
  return (await useInfra()).portDetail(mac, idx, range)
})
