import { WolTargetInput } from '#shared/schemas/automation'
import { useAutomation } from '../../../services/controller-runtime'
import { accessId, readAccessPatch } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const input = await readAccessPatch(event, WolTargetInput.partial())
  return (await useAutomation()).wol.update(id, input)
})
