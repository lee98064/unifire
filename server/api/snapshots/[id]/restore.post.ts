import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { RestoreInput } from '#shared/schemas/insight'
import { userActor } from '../../../services/audit'
import { useSnapshots } from '../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const input = await readApiBody(event, RestoreInput)
  return (await useSnapshots()).apply(id, input, { actor: userActor(admin) })
})
