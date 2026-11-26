import { ExtensionRequest } from '#shared/schemas/access'
import { useAccess } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { z } from 'zod'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { status } = await readApiQuery(event, z.object({ status: ExtensionRequest.shape.status.optional() }))
  return (await useAccess()).extensions.list(status)
})
