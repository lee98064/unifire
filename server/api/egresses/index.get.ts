import { useInventory } from '../../services/inventory-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async () => (await useInventory()).egresses())
