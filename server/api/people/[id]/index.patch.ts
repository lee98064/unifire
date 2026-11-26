import { PersonInput } from '#shared/schemas/access'
import { useAccess } from '../../../services/controller-runtime'
import { accessId, readAccessPatch } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const input = await readAccessPatch(event, PersonInput.partial())
  return (await useAccess()).people.update(id, input)
})
