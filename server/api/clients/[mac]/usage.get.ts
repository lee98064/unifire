import { ClientUsage } from '#shared/schemas/access'
import { useInventory } from '../../../services/inventory-runtime'
import { readApiParams, readApiQuery } from '../../../utils/api-error'
import { z } from 'zod'
import { Mac } from '#shared/schemas/common'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const { range } = await readApiQuery(event, z.object({ range: ClientUsage.shape.range.default('24h') }))
  return (await useInventory()).clientUsage(mac, range)
})
