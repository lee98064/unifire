import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { userActor } from '../../../../services/audit'
import { useInfra } from '../../../../services/controller-runtime'
import { readApiParams } from '../../../../utils/api-error'
import { adminControllerHandler } from '../../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const ctx = { actor: userActor(admin) }
  return (await useInfra()).poe.delete(id, ctx)
})
