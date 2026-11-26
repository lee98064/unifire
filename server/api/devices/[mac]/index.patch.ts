import { z } from 'zod'
import { Mac } from '#shared/schemas/common'
import { DeviceUpdateInput } from '#shared/schemas/infra'
import { useAccess, useInfra } from '../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const { roomId } = await readApiBody(event, DeviceUpdateInput)
  const infra = await useInfra()
  if (roomId !== undefined) (await useAccess()).rooms.assign(mac, roomId)
  return infra.get(mac)
})
