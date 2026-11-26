import { z } from 'zod'
import { Mac } from '#shared/schemas/common'
import { LocateInput } from '#shared/schemas/infra'
import { userActor } from '../../../services/audit'
import { useInfra } from '../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const input = await readApiBody(event, LocateInput)
  const infra = await useInfra()
  await infra.locate(mac, input, { actor: userActor(admin) })
  return infra.get(mac)
})
