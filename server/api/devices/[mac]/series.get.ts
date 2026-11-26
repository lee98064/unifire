import { z } from 'zod'
import { api } from '#shared/api'
import { Mac } from '#shared/schemas/common'
import type { SeriesRangeT } from '#shared/schemas/infra'
import { useInfra } from '../../../services/controller-runtime'
import { readApiParams, readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const { range } = await readApiQuery(event, api.deviceSeries.input as z.ZodType<{ range: SeriesRangeT }>)
  return (await useInfra()).series(mac, range)
})
