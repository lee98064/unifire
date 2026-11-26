import { ControllerInput } from '#shared/schemas/controller'
import { useController } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'
import { userActor } from '../../services/audit'

export default adminControllerHandler(async (event, admin) =>
  (await useController()).save(await readApiBody(event, ControllerInput), { actor: userActor(admin) }),
)
