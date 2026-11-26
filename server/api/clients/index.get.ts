import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useInventory } from '../../services/inventory-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

const Query = api.clients.input as ZodType<{ online?: boolean, personId?: string, q?: string }>

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, Query)
  return (await useInventory()).clients(query)
})
