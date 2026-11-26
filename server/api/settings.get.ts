import { defineEventHandler } from 'h3'
import { createSettingsService } from '../services/settings'
import { requireAdmin } from '../utils/auth'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return createSettingsService().get()
})
