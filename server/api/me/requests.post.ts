import { defineEventHandler } from 'h3'
import { ExtensionRequestInput } from '#shared/schemas/access'
import { useAccess } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { requireMember } from '../../utils/auth'

export default defineEventHandler(async event => {
  const { personId } = await requireMember(event)
  const input = await readApiBody(event, ExtensionRequestInput)
  return (await useAccess()).extensions.create(personId, input)
})
