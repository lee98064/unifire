import { z } from 'zod'
import { ClientActionInput } from '#shared/schemas/access'
import { Mac } from '#shared/schemas/common'
import { userActor } from '../../../services/audit'
import { useInventory } from '../../../services/inventory-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const input = await readApiBody(event, ClientActionInput)
  return (await useInventory()).clientAction(mac, input, { actor: userActor(admin) })
})
