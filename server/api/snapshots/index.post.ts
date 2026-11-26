import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { userActor } from '../../services/audit'
import { useSnapshots } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { note } = await readApiBody(event, api.snapshotCreate.input as ZodType<{ note?: string }>)
  return api.snapshotCreate.output.parse(await (await useSnapshots()).create(note, { actor: userActor(admin) }))
})
