import { z } from 'zod'
import { api } from '#shared/api'
import { Mac } from '#shared/schemas/common'
import { userActor } from '../../../services/audit'
import { useInfra } from '../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const { confirmGateway } = await readApiBody(event, api.deviceRestart.input as z.ZodType<{ confirmGateway: boolean }>)
  return (await useInfra()).restart(mac, confirmGateway, { actor: userActor(admin) })
})
