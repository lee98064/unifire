import { z } from 'zod'
import { ScheduleInput } from '#shared/schemas/routes'
import { userActor } from '../../../services/audit'
import { useRouting } from '../../../services/controller-runtime'
import { createSettingsService } from '../../../services/settings'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async (event, admin) => {
  const id = await routingId(event)
  const schedule = z.preprocess(value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'timezone')) {
      return { ...value, timezone: createSettingsService().get().timezone }
    }
    return value
  }, ScheduleInput)
  const input = await readApiBody(event, schedule)
  return (await useRouting()).managed.schedule(id, input, { actor: userActor(admin) })
})
