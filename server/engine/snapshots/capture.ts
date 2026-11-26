import { SnapshotResource, type SnapshotResourceT } from '#shared/schemas/insight'
import type { UnifiEndpoints } from '../../unifi/endpoints'
import type { WireDoc } from '../../unifi/endpoints/schemas'
import { UnifiError } from '../../unifi/errors'
import { itemIdentity, itemLabel, readCollection } from '../../unifi/snapshot-resources'
import { digest, type Collections, type SnapshotEntry } from './diff'
import type { Capture } from './store'

export function indexCollection(resource: SnapshotResourceT, docs: WireDoc[]) {
  const items = new Map<string, SnapshotEntry>()
  for (const doc of docs) {
    const id = itemIdentity(resource, doc)
    if (!id || items.has(id) || id === '.' || id === '..') throw new UnifiError('UNIFI_INVALID_RESPONSE')
    items.set(id, { id, label: itemLabel(resource, doc, id), doc, hash: digest(doc) })
  }
  return items
}

export async function captureCollections(api: UnifiEndpoints,
  resources: readonly SnapshotResourceT[] = SnapshotResource.options): Promise<Pick<Capture, 'collections' | 'failed'>> {
  const results = await Promise.allSettled(resources.map(async resource => indexCollection(resource, await readCollection(api, resource))))
  const collections: Collections = new Map()
  const failed: SnapshotResourceT[] = []
  results.forEach((result, index) => {
    const resource = resources[index]!
    if (result.status === 'fulfilled') collections.set(resource, result.value)
    else failed.push(resource)
  })
  return { collections, failed }
}
