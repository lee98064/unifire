import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useDb } from '../../db'
import { usageReport } from '../../engine/reports/usage'
import { createSettingsService } from '../../services/settings'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, api.usageReport.input as ZodType<{ range: '7d' | '30d' | 'month', month?: string }>)
  return usageReport(useDb(), query.range, query.month, createSettingsService().get().timezone)
})
