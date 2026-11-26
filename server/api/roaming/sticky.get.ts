import { useAccess } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async () => (await useAccess()).sticky.list())
