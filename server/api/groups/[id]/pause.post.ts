import { PauseInput } from '#shared/schemas/access'
import { useAccess } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { accessId } from '../../../utils/access-api'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const id = await accessId(event)
  const input = await readApiBody(event, PauseInput)
  return (await useAccess()).people.groupPause(id, input)
})
