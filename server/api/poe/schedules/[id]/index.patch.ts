import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { PoeScheduleInput } from '#shared/schemas/infra'
import { userActor } from '../../../../services/audit'
import { useInfra } from '../../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../../utils/api-error'
import { adminControllerHandler } from '../../../../utils/controller-api'

const patch = PoeScheduleInput.partial().extend({
  timezone: PoeScheduleInput.shape.timezone.removeDefault().optional(),
  mode: PoeScheduleInput.shape.mode.removeDefault().optional(),
  enabled: PoeScheduleInput.shape.enabled.removeDefault().optional(),
  acknowledgedAp: PoeScheduleInput.shape.acknowledgedAp.removeDefault().optional(),
})

export default adminControllerHandler(async (event, admin) => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const input = await readApiBody(event, patch)
  const ctx = { actor: userActor(admin) }
  return (await useInfra()).poe.update(id, input, ctx)
})
