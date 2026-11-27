import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { IncidentUpdateInput } from '#shared/schemas/infra'
import { useDb } from '../../../db'
import { createIncidentStore } from '../../../engine/infra/incidents/store'
import { createAuditService, userActor } from '../../../services/audit'
import { useController } from '../../../services/controller-runtime'
import { readApiBody, readApiParams } from '../../../utils/api-error'
import { liveBus } from '../../../utils/bus'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async (event, admin) => {
  const { id } = await readApiParams(event, z.object({ id: Id }))
  const input = await readApiBody(event, IncidentUpdateInput)
  const service = await useController()
  const db = useDb()
  const saved = createIncidentStore(db, service.runtime?.scope ?? '').update(id, input)
  if (input.acknowledged !== undefined || input.note !== undefined) {
    liveBus.emit({ type: 'incident', data: { id, status: saved.status, severity: saved.severity } })
    createAuditService(db).record({ actor: userActor(admin), category: 'system', action: 'incident.updated', severity: 'info',
      target: { type: 'incident', id, label: saved.titleParams.name ?? id }, messageKey: 'audit.incident.updated',
      messageParams: { name: saved.titleParams.name ?? id } })
  }
  return saved
})
