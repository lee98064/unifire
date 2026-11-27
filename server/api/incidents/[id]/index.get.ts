import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { useDb } from '../../../db'
import { createIncidentStore } from '../../../engine/infra/incidents/store'
import { useController } from '../../../services/controller-runtime'
import { readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const service = await useController()
  return createIncidentStore(useDb(), service.runtime?.scope ?? '').detail(id)
})
