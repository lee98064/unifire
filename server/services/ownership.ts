import { createHash } from 'node:crypto'
import type { RouteOwnershipT } from '#shared/schemas/routes'
import type { WireRoute } from '../unifi/endpoints/schemas'

export const PROBE_PREFIX = '[unifire-probe]'

export function classifyRoute(route: WireRoute, inputs: {
  managed: ReadonlyMap<string, { id: string }>
  excluded: ReadonlySet<string>
  probes: ReadonlySet<string>
}): RouteOwnershipT {
  if (inputs.excluded.has(route._id)) return 'excluded'
  if (Object.hasOwn(route, 'origin_type')) return 'object'
  if (route.predefined === true) return 'predefined'
  if (route.description?.startsWith(PROBE_PREFIX) && inputs.probes.has(route._id)) return 'probe'
  if (inputs.managed.has(route._id)) return 'managed'
  return 'external'
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function documentFingerprint(route: WireRoute) {
  return createHash('sha256').update(JSON.stringify(canonical(route))).digest('hex')
}

export function routeFingerprint(route: WireRoute) {
  // Only guard membership and forwarding semantics. Egress is deliberately mutable.
  const criteria = {
    target_devices: route.target_devices, matching_target: route.matching_target,
    domains: route.domains, ip_addresses: route.ip_addresses, ip_ranges: route.ip_ranges,
    regions: route.regions, kill_switch_enabled: route.kill_switch_enabled,
    enabled: route.enabled, next_hop: route.next_hop,
    // Preserve unfamiliar destination fields in the baseline as well.
    extra: Object.fromEntries(Object.entries(route).filter(([key]) =>
      /^(?:matching_|target_|destination_|app_|ip_|domain_|region)/.test(key)
      && !['matching_target', 'target_devices', 'ip_addresses', 'ip_ranges'].includes(key))),
  }
  return createHash('sha256').update(JSON.stringify(canonical(criteria))).digest('hex')
}
