import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { EgressUpdateInput } from '#shared/schemas/egress'
import { userActor } from '../../services/audit'
import { useInventory } from '../../services/inventory-runtime'
import { readApiBody, readApiParams } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const input = await readApiBody(event, EgressUpdateInput)
  return (await useInventory()).updateEgress(id, input, { actor: userActor(admin) })
})
