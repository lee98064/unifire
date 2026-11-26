import { defineEventHandler } from 'h3'
import { SettingsInput } from '#shared/schemas/system'
import { createAuditService, userActor } from '../services/audit'
import { createSettingsService } from '../services/settings'
import { readApiBody } from '../utils/api-error'
import { requireAdmin } from '../utils/auth'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const input = await readApiBody(event, SettingsInput)
  const user = await requireAdmin(event)
  const settings = createSettingsService().patch(input)
  const keys = Object.keys(input)
  if (keys.length > 0) {
    createAuditService().record({
      actor: userActor(user), category: 'config', action: 'config.settingsChanged', severity: 'success',
      messageKey: 'audit.config.settingsChanged', messageParams: { keys: keys.join(', ') },
    })
  }
  return settings
})
