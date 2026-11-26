import { CapabilityKey, type CapabilityKeyT, type CapabilityT, type ControllerModeT } from '#shared/schemas/controller'
import type { UnifiEndpoints } from './endpoints'
import { UnifiError, unifiErrorCode, unifiStatusKey } from './errors'
import { readSpeedtest } from './speedtest'
import type { WriteContext, createWriteGate } from './writes'

const empty = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object' && 'data' in value && Array.isArray(value.data)) return !value.data.length
  return value === null
}

export async function probeCapabilities(options: {
  api: UnifiEndpoints
  authenticate: () => Promise<unknown>
  websocket: () => Promise<void>
  writes: Pick<ReturnType<typeof createWriteGate>, 'qualifyRoutes'>
  mode: ControllerModeT
  selfMac: string | null
  context: WriteContext
}) {
  const matrix = new Map<CapabilityKeyT, CapabilityT>()
  function put(key: CapabilityKeyT, status: CapabilityT['status'], detail: string | null = null) {
    matrix.set(key, { key, status, detail, checkedAt: Date.now() })
  }

  async function check<T>(key: CapabilityKeyT, read: () => Promise<T>, details?: string) {
    try {
      const output = await read()
      put(key, 'ok', empty(output) ? 'capability.empty' : details)
      return output
    } catch (error) {
      put(key, 'fail', unifiStatusKey(unifiErrorCode(error)))
    }
  }

  const { api } = options
  const auth = await check('auth', async () => {
    await options.authenticate()
    return true
  })
  if (auth) {
    const [networks] = await Promise.all([
      check('networkconf', api.networks),
      check('sysinfo', async () => {
        const sysinfo = await api.sysinfo()
        if (!sysinfo.length) throw new UnifiError('UNIFI_EMPTY')
        return sysinfo
      }),
      check('routes.read', api.routes),
      check('objects.read', api.objects),
      check('clients.active', api.activeClients),
      check('clients.known', api.knownClients),
      check('devices', api.devices),
      check('websocket', options.websocket),
      check('stats.series', () => api.statsSeries({
        schema: 'activityBySiteByClient', period: 'HOUR', end: Date.now(), projection: 'values(rxBytes,txBytes)',
      })),
      check('systemlog', () => api.systemLog('all', { pageNumber: 0, pageSize: 1 })),
      check('wlanconf', api.wlans),
      check('speedtest', async () => {
        const value = await readSpeedtest(api)
        if (!value.available) throw new UnifiError('UNIFI_UNSUPPORTED', 404)
        return value
      }, 'capability.speedtestStatusOnly'),
    ])
    put('stamgr', 'unknown', 'capability.requiresAction')
    put('devmgr.powercycle', 'unknown', 'capability.requiresAction')

    const egressId = networks?.find(network => network.purpose === 'wan' && network.enabled !== false)?._id
    const skip = options.mode === 'dry-run' || options.context.dryRun ? 'capability.dryRun'
      : !options.selfMac ? 'capability.selfMacRequired'
      : !egressId ? 'capability.wanRequired'
      : matrix.get('routes.read')?.status !== 'ok' ? 'capability.routesRequired' : null
    const results = skip || !options.selfMac || !egressId ? undefined
      : await options.writes.qualifyRoutes(options.selfMac, egressId, options.context)

    for (const key of ['routes.create', 'routes.update', 'routes.delete'] as const) {
      const error = results?.get(key)
      if (error === undefined) put(key, 'skipped', skip ?? 'capability.scratchUnavailable')
      else put(key, error === null ? 'ok' : 'fail', unifiStatusKey(error))
    }
  }

  return CapabilityKey.options.map(key => matrix.get(key) ?? {
    key, status: 'skipped', detail: 'capability.authRequired', checkedAt: null,
  } satisfies CapabilityT)
}
