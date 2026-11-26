import { PoeWatchdogInput } from '#shared/schemas/automation'
import { useAutomation } from '../../services/controller-runtime'
import { readApiBody } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const input = await readApiBody(event, PoeWatchdogInput)
  return (await useAutomation()).watchdogs.create(input)
})
