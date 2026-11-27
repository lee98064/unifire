import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useDb } from '../../db'
import { infrastructureReport } from '../../engine/reports/infra'
import { useController } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { month } = await readApiQuery(event, api.infraReport.input as ZodType<{ month: string }>)
  return infrastructureReport(useDb(), await useController(), month)
})
