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
}

export function readCollection(api: UnifiEndpoints, resource: SnapshotResourceT): Promise<WireDoc[]> {
  const definition = snapshotResources[resource]
  return api.configCollection(definition.path, definition.v2 === true)
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

export function itemIdentity(resource: SnapshotResourceT, doc: WireDoc) {
  return firstText(doc._id, doc.id, resource === 'users' ? doc.mac : undefined)
}

export function itemLabel(resource: SnapshotResourceT, doc: WireDoc, id: string) {
  return (resource === 'trafficroutes' ? firstText(doc.description)
    : firstText(doc.name, doc.description, doc.hostname, doc.mac)) ?? id
}

export function resourcePath(paths: ReturnType<typeof osPaths>, resource: SnapshotResourceT, id?: string) {
  const definition = snapshotResources[resource]
  const path = id === undefined ? definition.path : `${definition.write?.itemPath ?? definition.path}/${segment(id)}`
  return definition.v2 ? paths.v2(path) : paths.classic(path)
}
