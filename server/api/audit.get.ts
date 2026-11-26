import { defineEventHandler } from 'h3'
import { AuditQuery } from '#shared/schemas/insight'
import { createAuditService } from '../services/audit'
import { readApiQuery } from '../utils/api-error'
import { requireAdmin } from '../utils/auth'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const query = await readApiQuery(event, AuditQuery)
  return createAuditService().list(query)
})
