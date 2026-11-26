import { z } from 'zod'
import { Mac } from '#shared/schemas/common'
import { useInventory } from '../../../services/inventory-runtime'
import { readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  return (await useInventory()).client(mac)
})
