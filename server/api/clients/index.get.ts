import { z } from 'zod'
import { api } from '#shared/api'
import { useInventory } from '../../services/inventory-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

const Query = z.preprocess((input: unknown) => {
  if (input && typeof input === 'object' && 'online' in input && input.online === 'false') return { ...input, online: false }
  return input
}, api.clients.input! as z.ZodType<{ online?: boolean, personId?: string, q?: string }>)

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, Query)
  return (await useInventory()).clients(query)
})
