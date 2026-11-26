import { z } from 'zod'
import type { UnifiTransport } from '../client'
import { isUnsupported, UnifiError } from '../errors'
import { segment } from '../paths'
import { ActiveStation, Device, Doc, Docs, Network, Route, Site, Station, Sysinfo, SystemLogPage, WlanDoc } from './schemas'

export function parseWire<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new UnifiError('UNIFI_INVALID_RESPONSE')
  return parsed.data
}

export function createUnifiEndpoints({ paths, read, postRead }: UnifiTransport) {
  const get = async <T>(path: string, schema: z.ZodType<T>) => parseWire(schema, await read(path))
  const classic = <T>(path: string, schema: z.ZodType<T>) => get(paths.classic(path), schema)
  const v2 = <T>(path: string, schema: z.ZodType<T>) => get(paths.v2(path), schema)

  async function activeClients() {
    try {
      return await v2('clients/active?includeTrafficUsage=true&includeUnifiDevices=true', z.array(ActiveStation))
    } catch (error) {
      if (!isUnsupported(error) && !(error instanceof UnifiError && error.code === 'UNIFI_INVALID_RESPONSE')) throw error
      return statStations()
    }
  }

  function statStations() { return classic('stat/sta', z.array(Station)) }
  function users() { return classic('rest/user', z.array(Station)) }
  function allUsers() { return classic('stat/alluser', z.array(Station)) }

  async function knownClients() {
    try { return await users() } catch (error) {
      if (!isUnsupported(error)) throw error
      return allUsers()
    }
  }

  return {
    configCollection: (path: string, isV2: boolean) => (isV2 ? v2 : classic)(path, Docs),
    sysinfo: () => classic('stat/sysinfo', z.array(Sysinfo)),
    sites: () => get(paths.sites, z.array(Site)),
    networks: () => classic('rest/networkconf', z.array(Network)),
    routes: () => v2('trafficroutes', z.array(Route)),
    objects: () => v2('object-oriented-network-configs', Docs),
    activeClients, statStations, users, allUsers, knownClients,
    devices: () => classic('stat/device', z.array(Device)),
    async device(mac: string) {
      const found = (await classic(`stat/device/${segment(mac)}`, z.array(Device)))
        .find(device => device.mac === mac && device.adopted !== false)
      if (!found) throw new UnifiError('DEVICE_NOT_FOUND', 404)
      return found
    },
    wlans: () => classic('rest/wlanconf', z.array(WlanDoc)),
    gateway: () => classic('stat/gateway', z.array(Device)),
    health: () => classic('stat/health', Docs),
    systemLog: async (category: 'all' | 'critical' | 'threat-alert' | 'client-alert', query: {
      pageNumber: number, pageSize: number, timestampFrom?: number, timestampTo?: number
    }) => parseWire(SystemLogPage, await postRead(paths.v2(`system-log/${category}`), query)),
    statsSchemas: () => get(paths.stats('schemas'), z.union([Doc, z.array(z.union([Doc, z.string()]))])),
    statsSeries: (query: { schema: string, end: number, period?: string, start?: number, projection?: string, filter?: string }) =>
      get(`${paths.stats('recent/series')}?${new URLSearchParams(
        Object.entries(query).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]),
      )}`, z.union([Doc, Docs])),
    speedtestStatus: async () => parseWire(z.union([Doc, Docs]), await postRead(paths.classic('cmd/devmgr'), { cmd: 'speedtest-status' })),
    speedtestWidget: () => v2('aggregated-dashboard?historySeconds=86400', Doc).then(doc => ({ speed_test: doc.speed_test ?? doc.speedtest })),
    firewallZones: () => v2('firewall/zone', Docs),
    firewallPolicies: () => v2('firewall-policies', Docs),
    portForwards: () => classic('rest/portforward', Docs),
    routing: () => classic('rest/routing', Docs),
    staticDns: () => v2('static-dns', Docs),
    qosRules: () => v2('qos-rules', Docs),
    portConf: () => classic('rest/portconf', Docs),
    user: (id: string) => classic(`rest/user/${segment(id)}`, z.array(Station)),
    wlan: (id: string) => classic(`rest/wlanconf/${segment(id)}`, z.array(WlanDoc)),
  }
}

export type UnifiEndpoints = ReturnType<typeof createUnifiEndpoints>
