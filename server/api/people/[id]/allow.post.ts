import { AllowanceInput } from '#shared/schemas/access'
import { useAccess } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { accessId } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const input = await readApiBody(event, AllowanceInput)
  return (await useAccess()).people.allow(id, input.minutes)
})
