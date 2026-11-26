import { useRouting } from '../../../services/controller-runtime'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async () => (await useRouting()).sweep.get())
