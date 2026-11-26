import { RoomInput } from '#shared/schemas/infra'
import { useAccess } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const input = await readApiBody(event, RoomInput)
  return (await useAccess()).rooms.create(input)
})
