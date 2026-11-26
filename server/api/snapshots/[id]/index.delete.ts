import { z } from 'zod'
import { Id, Ok } from '#shared/schemas/common'
import { userActor } from '../../../services/audit'
import { useSnapshots } from '../../../services/controller-runtime'
import { readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  return Ok.parse((await useSnapshots()).remove(id, { actor: userActor(admin) }))
})
