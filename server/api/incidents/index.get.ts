import { IncidentQuery } from '#shared/schemas/infra'
import { useDb } from '../../db'
import { createIncidentStore } from '../../engine/infra/incidents/store'
import { useController } from '../../services/controller-runtime'
import { readApiQuery } from '../../utils/api-error'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async event => {
  const query = await readApiQuery(event, IncidentQuery)
  const service = await useController()
  return createIncidentStore(useDb(), service.runtime?.scope ?? '').list(query)
})
