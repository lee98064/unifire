import { PortEventAckAllInput } from '#shared/schemas/infra'
import { useInfra } from '../../../services/controller-runtime'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { switchMac } = await readApiBody(event, PortEventAckAllInput)
  return (await useInfra()).ackPortEvents(switchMac)
})
