import { RoomAssignInput } from '#shared/schemas/infra'
import { useAccess } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { apMac, roomId } = await readApiBody(event, RoomAssignInput)
  return (await useAccess()).rooms.assign(apMac, roomId)
})
