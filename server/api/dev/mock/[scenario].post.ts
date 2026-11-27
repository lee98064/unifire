import { z } from 'zod'
import { checkMockConfig, useController, useInfra } from '../../../services/controller-runtime'
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
  const external = parsed.data === 'config-then-outage'
  if (external) await checkMockConfig()
  const result = apply(parsed.data)
  if (external) await checkMockConfig()
  await cache.refreshAfterCurrent('devices')
  // Confirm missing adopted devices before processing the burst of client disconnects.
  if (external || parsed.data === 'offline-switch' || parsed.data === 'downgrade-port') await cache.refresh('devices')
  await cache.refreshAfterCurrent('activeClients')
  return { ok: true, scenario: parsed.data, result }
})
