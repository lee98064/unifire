import { useInventory } from '../services/inventory-runtime'
import { adminControllerHandler } from '../utils/controller-api'
import { api } from '#shared/api'

export default adminControllerHandler(async () => api.networks.output.parse((await useInventory()).networks()))
