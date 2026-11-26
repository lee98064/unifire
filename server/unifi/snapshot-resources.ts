import type { AuditCategoryT, SnapshotResourceT } from '#shared/schemas/insight'
import type { UnifiEndpoints } from './endpoints'
import type { WireDoc } from './endpoints/schemas'
import type { osPaths } from './paths'
import { segment } from './paths'

type Resource = {
  path: string
  v2?: true
  category: AuditCategoryT
  write?: { itemPath?: string, remove?: true }
}

export const snapshotResources: Record<SnapshotResourceT, Resource> = {
  trafficroutes: { path: 'trafficroutes', v2: true, category: 'route', write: { remove: true } },
  objects: { path: 'object-oriented-network-configs', v2: true, category: 'config', write: { itemPath: 'object-oriented-network-config' } },
  'firewall-policies': { path: 'firewall-policies', v2: true, category: 'config', write: {} },
  'firewall-zones': { path: 'firewall/zone', v2: true, category: 'config' },
  networkconf: { path: 'rest/networkconf', category: 'config' },
  wlanconf: { path: 'rest/wlanconf', category: 'wifi', write: {} },
  portforward: { path: 'rest/portforward', category: 'config', write: { remove: true } },
  routing: { path: 'rest/routing', category: 'config' },
  'static-dns': { path: 'static-dns', v2: true, category: 'config', write: { remove: true } },
  'qos-rules': { path: 'qos-rules', v2: true, category: 'config' },
  users: { path: 'rest/user', category: 'client', write: {} },
  portconf: { path: 'rest/portconf', category: 'config' },
  devices: { path: 'stat/device', category: 'device' },
}

export function readCollection(api: UnifiEndpoints, resource: SnapshotResourceT): Promise<WireDoc[]> {
  if (resource === 'devices') return api.devices().then(devices => devices.filter(device => device.adopted !== false).map(deviceConfig))
  const definition = snapshotResources[resource]
  return api.configCollection(definition.path, definition.v2 === true)
}

const deviceFields = ['_id', 'mac', 'name', 'model', 'type', 'port_overrides', 'radio_table', 'led_override',
  'config_network', 'mgmt_network_id', 'ethernet_overrides', 'device_mode_override']
const radioFields = ['name', 'radio', 'channel', 'ht', 'tx_power', 'tx_power_mode', 'min_rssi', 'min_rssi_enabled',
  'loadbalance_enabled', 'loadbalance_num_sta', 'hard_noise_floor_enabled', 'hard_noise_floor', 'sens_level_enabled',
  'sens_level', 'vwire_enabled', 'antenna_id', 'antenna_gain']

export function deviceConfig(doc: WireDoc): WireDoc {
  const pick = (source: WireDoc, keys: string[]) => Object.fromEntries(keys
    .filter(key => source[key] != null).map(key => [key, source[key]]))
  const config = pick(doc, deviceFields)
  if (Array.isArray(config.radio_table)) config.radio_table = config.radio_table.map(row => pick(row, radioFields))
    .sort((a, b) => String(a.name ?? a.radio ?? '').localeCompare(String(b.name ?? b.radio ?? '')))
  if (Array.isArray(config.port_overrides)) config.port_overrides = [...config.port_overrides]
    .sort((a, b) => Number(a.port_idx) - Number(b.port_idx))
  return config
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

export function itemIdentity(resource: SnapshotResourceT, doc: WireDoc) {
  return firstText(doc._id, doc.id, resource === 'users' || resource === 'devices' ? doc.mac : undefined)
}

export function itemLabel(resource: SnapshotResourceT, doc: WireDoc, id: string) {
  return (resource === 'trafficroutes' ? firstText(doc.description)
    : resource === 'devices' ? firstText(doc.name, doc.model, doc.mac)
      : firstText(doc.name, doc.description, doc.hostname, doc.mac)) ?? id
}

export function resourcePath(paths: ReturnType<typeof osPaths>, resource: SnapshotResourceT, id?: string) {
  const definition = snapshotResources[resource]
  const path = id === undefined ? definition.path : `${definition.write?.itemPath ?? definition.path}/${segment(id)}`
  return definition.v2 ? paths.v2(path) : paths.classic(path)
}
