import { z } from 'zod'
import { useAutomation } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, z.object({ ruleId: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().default(50) }))
  return (await useAutomation()).rules.page(query)
})
