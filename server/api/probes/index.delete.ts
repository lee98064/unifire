import { userActor } from '../../services/audit'
import { useRouting } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (_event, admin) => (await useRouting()).sweep.cleanup({ actor: userActor(admin) }))
