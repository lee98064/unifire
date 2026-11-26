import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DiffChangeT, FieldChangeT, SnapshotResourceT } from '#shared/schemas/insight'
import type { WireDoc } from '../../unifi/endpoints/schemas'
import { isSecretKey } from '../../utils/redact'

const volatile = new Set([
  'created_at', 'create_time', 'updated_at', 'update_time', 'modified_at', 'last_modified',
  'timestamp', 'last_seen', 'first_seen', 'uptime', 'online', 'rx_bytes', 'tx_bytes',
  'rx_bytes-r', 'tx_bytes-r', 'rx_packets', 'tx_packets', 'hit_count', 'packet_count', 'byte_count',
  'createdAt', 'updatedAt', 'lastModified', 'lastSeen', 'firstSeen', 'rxBytes', 'txBytes',
  'rxPackets', 'txPackets', 'hitCount', 'packetCount', 'byteCount',
])

const isDocument = (value: unknown): value is WireDoc => value !== null && typeof value === 'object' && !Array.isArray(value)

export function secretField(key: string) {
  return isSecretKey(key) || /pass|secret|private|psk|token|key$/i.test(key)
}

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isDocument(value)) return value
  return Object.fromEntries(Object.keys(value).sort().filter(key => !volatile.has(key))
    .map(key => [key, normalize(value[key])]))
}

export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

export function redactDocument(doc: WireDoc): WireDoc {
  const redact = (value: unknown): unknown => Array.isArray(value) ? value.map(redact) : isDocument(value) ? redactDocument(value) : value
  return Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, secretField(key) ? null : redact(value)]))
}

export type SnapshotEntry = { id: string, label: string, hash: string, doc: WireDoc }
export type Collections = Map<SnapshotResourceT, Map<string, SnapshotEntry>>
export type Labels = (key: string, value: unknown) => string | null

export function labelResolver(collections: Collections, clientNames: ReadonlyMap<string, string> = new Map()): Labels {
  const clients = new Map([...collections.get('users')?.values() ?? []].flatMap(({ doc, label }) =>
    typeof doc.mac === 'string' ? [[doc.mac.toLowerCase(), label] as const] : []))
  for (const [mac, name] of clientNames) clients.set(mac, name)
  return (key, value) => {
    if (typeof value !== 'string') return null
    const field = key.replaceAll('_', '').toLowerCase()
    if (field === 'clientmac' || field === 'mac') return clients.get(value.toLowerCase()) ?? null
    const resource = /^(?:network(?:conf)?|egress)ids?$/.test(field) ? 'networkconf'
      : /zoneids?$/.test(field) ? 'firewall-zones'
        : /^(?:wlan(?:conf)?|ssid)ids?$/.test(field) ? 'wlanconf' : undefined
    return resource ? collections.get(resource)?.get(value)?.label ?? null : null
  }
}

export function fieldDiff(before: unknown, after: unknown, beforeLabel?: Labels, afterLabel?: Labels): FieldChangeT[] {
  const fields: FieldChangeT[] = []
  function walk(left: unknown, right: unknown, path: string, key: string, secret = false) {
    if (isDeepStrictEqual(left, right)) return
    if (!secret && (isDocument(left) || isDocument(right))
      && (left == null || isDocument(left)) && (right == null || isDocument(right))) {
      const a = isDocument(left) ? left : {}
      const b = isDocument(right) ? right : {}
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      if (keys.size) {
        for (const child of keys) {
          walk(Object.hasOwn(a, child) ? a[child] : undefined, Object.hasOwn(b, child) ? b[child] : undefined,
            path ? `${path}.${child}` : child, child, secretField(child))
        }
        return
      }
    }
    if (!secret && (Array.isArray(left) || Array.isArray(right))
      && (left == null || Array.isArray(left)) && (right == null || Array.isArray(right))) {
      const a = Array.isArray(left) ? left : []
      const b = Array.isArray(right) ? right : []
      if (a.length || b.length) {
        for (let index = 0; index < Math.max(a.length, b.length); index++) walk(a[index], b[index], `${path}[${index}]`, key)
        return
      }
    }
    // Mixed types can still contain nested secret keys.
    const safe = (value: unknown): unknown => isDocument(value) ? redactDocument(value) : Array.isArray(value) ? value.map(safe) : value ?? null
    fields.push({ path, before: secret ? null : safe(left), after: secret ? null : safe(right), secret,
      beforeLabel: secret ? null : beforeLabel?.(key, left) ?? null,
      afterLabel: secret ? null : afterLabel?.(key, right) ?? null })
  }
  walk(normalize(before), normalize(after), '', '')
  return fields
}

export function summary(resource: SnapshotResourceT, label: string, kind: DiffChangeT['kind'], fields: FieldChangeT[],
  before?: WireDoc, after?: WireDoc) {
  if (resource === 'devices' && kind === 'modified') {
    const value = (field: FieldChangeT) => ({
      from: field.beforeLabel ?? String(field.before ?? ''), to: field.afterLabel ?? String(field.after ?? ''),
    })
    const name = fields.find(field => field.path === 'name')
    if (name) return { summaryKey: 'diff.device.name', summaryParams: { device: label, ...value(name) } }
    for (const field of fields) {
      const match = /^(port_overrides|radio_table)\[(\d+)\]\.(.+)$/.exec(field.path)
      if (!match || field.secret) continue
      const [, collection, index, leaf] = match
      const right = after?.[collection!]
      const left = before?.[collection!]
      const oldRow = Array.isArray(left) ? left[Number(index)] : undefined
      const newRow = Array.isArray(right) ? right[Number(index)] : undefined
      const port = collection === 'port_overrides'
      const identify = (row: unknown) => isDocument(row) ? row[port ? 'port_idx' : 'radio'] ?? row.name : undefined
      const identity = identify(newRow) ?? identify(oldRow)
      if (identity !== undefined && (!oldRow || !newRow || identify(oldRow) === identify(newRow))) {
        const key = port ? 'port' : 'radio'
        return { summaryKey: `diff.device.${port ? 'port_override' : 'radio'}`,
          summaryParams: { device: label, [key]: String(identity), field: leaf!, ...value(field) } }
      }
    }
  }
  const egress = fields.find(field => field.path === 'network_id')
  const toggle = fields.find(field => field.path === 'enabled')
  const password = fields.some(field => /pass|psk/i.test(field.path) && field.secret)
  let suffix: string = kind
  let summaryParams: Record<string, string> = { resource, label }
  if (kind === 'modified') {
    if (resource === 'trafficroutes' && egress) {
      suffix = 'routeEgress'
      summaryParams = { route: label, from: egress.beforeLabel ?? String(egress.before ?? ''), to: egress.afterLabel ?? String(egress.after ?? '') }
    } else if (resource === 'trafficroutes' && toggle) {
      suffix = 'routeToggled'
      summaryParams = { route: label, state: String(toggle.after) }
    } else if (resource === 'wlanconf' && password) {
      suffix = 'wifiPassword'
      summaryParams = { ssid: label }
    } else if (resource === 'firewall-policies' && toggle) {
      suffix = 'firewallToggled'
      summaryParams = { name: label, state: String(toggle.after) }
    } else summaryParams.fields = String(fields.length)
  }
  return { summaryKey: `snapshots.summary.${suffix}`, summaryParams }
}

export function* compareMaps<T extends { hash: string }>(before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>) {
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id)
    const right = after.get(id)
    if (left?.hash === right?.hash) continue
    yield { id, left, right, kind: (left ? right ? 'modified' : 'removed' : 'added') as DiffChangeT['kind'] }
  }
}
