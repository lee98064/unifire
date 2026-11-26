import { useController } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'
import { userActor } from '../../services/audit'

export default adminControllerHandler(async (_event, admin) => (await useController()).probe({ actor: userActor(admin) }))
