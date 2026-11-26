import { PersonInput } from '#shared/schemas/access'
import { useAccess } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const input = await readApiBody(event, PersonInput)
  return (await useAccess()).people.create(input)
})
