import { userActor } from '../../services/audit'
import { useSpeedtests } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (_event, admin) => (await useSpeedtests()).start({ actor: userActor(admin) }))
