import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { useDb } from '../../db'
import { ispReport } from '../../engine/reports/isp'
import { useController } from '../../services/controller-runtime'
import { savedController } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, api.ispReport.input as ZodType<{ month: string }>)
  const db = useDb()
  const runtime = (await useController().catch(() => undefined))?.runtime
  const { timezone, probe } = createSettingsService(db).get()
  return ispReport(db, query.month, timezone, runtime?.config.site ?? savedController(db)?.site ?? 'default',
    runtime?.scope, probe.intervalSec * 1000)
})
