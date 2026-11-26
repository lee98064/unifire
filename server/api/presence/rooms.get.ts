import { z } from 'zod'
import { api } from '#shared/api'
import { Ts } from '#shared/schemas/common'
import { useAccess } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

const query = api.roomTimeline.input!.pipe(z.object({ from: Ts, to: Ts }).refine(range => range.from <= range.to))

export default adminControllerHandler(async event => {
  const { from, to } = await readApiQuery(event, query)
  return (await useAccess()).rooms.timeline(from, to)
})
