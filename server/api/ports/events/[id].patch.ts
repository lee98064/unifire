import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { PortEventUpdateInput } from '#shared/schemas/infra'
import { useInfra } from '../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const { acknowledged } = await readApiBody(event, PortEventUpdateInput)
  return (await useInfra()).updatePortEvent(id, acknowledged)
})
