import { useRouting } from '../../../services/controller-runtime'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async event => (await useRouting()).managed.get(await routingId(event)))
