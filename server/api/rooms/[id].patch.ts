import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { RoomInput } from '#shared/schemas/infra'
import { useAccess } from '../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

const patch = z.looseObject({}).transform((body, ctx) => {
  const result = RoomInput.partial().safeParse(body)
  if (!result.success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid room patch' })
    return z.NEVER
  }
  // Zod applies defaults inside partial fields. A PATCH must keep omitted values.
  for (const key of RoomInput.keyof().options) if (!Object.hasOwn(body, key)) delete result.data[key]
  return result.data
})
export default adminControllerHandler(async event => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const input = await readApiBody(event, patch)
  return (await useAccess()).rooms.update(id, input)
})
