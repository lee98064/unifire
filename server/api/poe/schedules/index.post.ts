import { PoeScheduleInput } from '#shared/schemas/infra'
import { userActor } from '../../../services/audit'
import { useInfra } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const input = await readApiBody(event, PoeScheduleInput)
  const ctx = { actor: userActor(admin) }
  return (await useInfra()).poe.create(input, ctx)
})
