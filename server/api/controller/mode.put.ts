import { ModeInput } from '#shared/schemas/controller'
import { useController } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'
import { userActor } from '../../services/audit'

export default adminControllerHandler(async (event, admin) => {
  const { mode } = await readApiBody(event, ModeInput)
  return (await useController()).setMode(mode, { actor: userActor(admin) })
})
