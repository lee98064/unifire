import { PortEventQuery } from '#shared/schemas/infra'
import { useInfra } from '../../../services/controller-runtime'
import { readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const input = await readApiQuery(event, PortEventQuery)
  return (await useInfra()).portEvents(input)
})
