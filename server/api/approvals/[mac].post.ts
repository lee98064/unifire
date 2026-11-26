import { ApprovalDecisionInput } from '#shared/schemas/access'
import { useAccess } from '../../services/controller-runtime'
import { userActor } from '../../services/audit'
import { readApiBody, readApiParams } from '../../utils/api-error'
import { z } from 'zod'
import { Mac } from '#shared/schemas/common'
import { useInventory } from '../../services/inventory-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { mac } = await readApiParams(event, z.object({ mac: Mac }))
  const input = await readApiBody(event, ApprovalDecisionInput)
  await (await useAccess()).approval(mac, input, { actor: userActor(admin) })
  return (await useInventory()).client(mac)
})
