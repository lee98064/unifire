import { z } from 'zod'
import { useController, useInfra } from '../../../services/controller-runtime'
import { MockScenario } from '../../../unifi/mock/infra'
import { apiError, readApiParams } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const service = await useController()
  const apply = service.mockScenario
  const notFound = () => apiError(404, 'NOT_FOUND', 'errors.notFound')
  if (!apply) throw notFound()
  const { scenario } = await readApiParams(event, z.object({ scenario: z.string() }))
  const parsed = MockScenario.safeParse(scenario)
  if (!parsed.success) throw notFound()
  await useInfra()
  const cache = service.runtime?.cache
  if (!cache) throw notFound()
  const result = apply(parsed.data)
  await Promise.all([cache.refreshAfterCurrent('devices'), cache.refreshAfterCurrent('activeClients')])
  // Missing devices are confirmed after two successful polls.
  if (parsed.data === 'offline-switch' || parsed.data === 'downgrade-port') await cache.refresh('devices')
  return { ok: true, scenario: parsed.data, result }
})
