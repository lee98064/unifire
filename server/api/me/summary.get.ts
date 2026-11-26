import { defineEventHandler } from 'h3'
import { useAccess } from '../../services/controller-runtime'
import { useInventory } from '../../services/inventory-runtime'
import { requireMember } from '../../utils/auth'

export default defineEventHandler(async event => {
  const { personId } = await requireMember(event)
  const access = await useAccess()
  return access.summary(personId, (await useInventory()).clients)
})
