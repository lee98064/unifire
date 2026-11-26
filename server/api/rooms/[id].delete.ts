import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { useAccess } from '../../services/controller-runtime'
import { readApiParams } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  return (await useAccess()).rooms.delete(id)
})
