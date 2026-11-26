import type { ZodType } from 'zod'
import { api } from '#shared/api'
import type { EgressHistoryT } from '#shared/schemas/egress'
import { useDb } from '../../../db'
import { egressHistory } from '../../../engine/probes/health'
import { useRouting } from '../../../services/controller-runtime'
import { readApiQuery } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'
import { routingId } from '../../../utils/routing-api'

export default adminControllerHandler(async event => {
  const id = await routingId(event)
  const { range } = await readApiQuery(event, api.egressHistory.input as ZodType<{ range: EgressHistoryT['range'] }>)
  const { probes } = await useRouting()
  return egressHistory(useDb(), id, probes.exits().some(exit => exit.id === id), range)
})
