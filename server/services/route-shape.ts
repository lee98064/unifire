import { isIP } from 'node:net'
import { z } from 'zod'
import { MatchingTarget, RouteTarget, type MatchingTargetT, type RouteTargetT, type UnifiRouteTargetT } from '#shared/schemas/routes'
import { MacAddress, type WireRoute } from '../unifi/endpoints/schemas'
import { redactSecrets } from '../utils/redact'

const text = z.string()

export function routeTargets(route: WireRoute) {
  return route.target_devices.map((value): UnifiRouteTargetT => {
    const mac = MacAddress.safeParse(value.client_mac).data
    const result = RouteTarget.safeParse({ type: value.type, mac, networkId: value.network_id })
    return result.success ? result.data : { type: 'OTHER', raw: JSON.stringify(redactSecrets(value)) }
  })
}

export function routeDestinations(route: WireRoute): string[] {
  if (route.matching_target === 'REGION') return route.regions ?? []
  if (route.matching_target === 'DOMAIN') {
    return (route.domains ?? []).flatMap(value => typeof value === 'string' ? [value] : text.safeParse(value.domain).data ?? [])
  }
  if (route.matching_target === 'IP') {
    return [
      ...(route.ip_addresses ?? []).flatMap(value => typeof value === 'string' ? [value] : text.safeParse(value.ip_or_subnet).data ?? []),
      ...(route.ip_ranges ?? []).flatMap(value => typeof value.ip_start === 'string' && typeof value.ip_stop === 'string'
        ? [`${value.ip_start}–${value.ip_stop}`] : []),
    ]
  }
  return []
}

export function managedRouteShape(route: WireRoute) {
  const matchingTarget = MatchingTarget.safeParse(route.matching_target).data
  const targets = RouteTarget.array().safeParse(routeTargets(route)).data
  if (!matchingTarget || !targets) return
  return { matchingTarget, targets, destinations: routeDestinations(route), killSwitch: route.kill_switch_enabled ?? false }
}

export function ipDestination(ip: string) {
  return { ip_or_subnet: ip, ip_version: isIP(ip.split('/')[0] ?? '') === 6 ? 'v6' : 'v4', ports: [], port_ranges: [] }
}

export function routeDraft(input: {
  name: string, targets: RouteTargetT[], matchingTarget: MatchingTargetT, destinations: string[],
  defaultEgressId: string, killSwitch: boolean, enabled?: boolean,
}) {
  return {
    description: input.name, enabled: input.enabled ?? true, matching_target: input.matchingTarget,
    target_devices: input.targets.map(target => target.type === 'CLIENT' ? { type: target.type, client_mac: target.mac }
      : target.type === 'NETWORK' ? { type: target.type, network_id: target.networkId } : { type: target.type }),
    domains: input.matchingTarget === 'DOMAIN' ? input.destinations.map(domain => ({ domain, ports: [], port_ranges: [] })) : [],
    ip_addresses: input.matchingTarget === 'IP' ? input.destinations.map(ipDestination) : [],
    ip_ranges: [], regions: input.matchingTarget === 'REGION' ? input.destinations : [],
    network_id: input.defaultEgressId, next_hop: '', kill_switch_enabled: input.killSwitch,
  } satisfies Omit<WireRoute, '_id'>
}
