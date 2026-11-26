import { QuotaInput } from '#shared/schemas/access'
import { useAccess } from '../../../services/controller-runtime'
import { accessId, readAccessPatch } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const input = await readAccessPatch(event, QuotaInput.partial())
  return (await useAccess()).quotas.update(id, input)
})
