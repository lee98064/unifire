import { z } from 'zod'
import { useAutomation } from '../../../services/controller-runtime'
import { accessId } from '../../../utils/access-api'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const id = await accessId(event)
  const { dryRun } = await readApiBody(event, z.object({ dryRun: z.boolean().default(true) }))
  return (await useAutomation()).rules.test(id, dryRun, admin)
})
