import { z } from 'zod'
import { Id, Mac } from '#shared/schemas/common'

export const Doc = z.looseObject({})
export const Docs = z.array(Doc)
export const MacAddress = z.string().transform(value => value.toLowerCase()).pipe(Mac)
const text = z.string().nullish()
const number = z.number().nullish()
const flag = z.boolean().nullish()

export const Sysinfo = z.looseObject({
  version: z.string(), console_display_version: text, udm_version: text, name: text, timezone: text,
})
export const Site = z.looseObject({ _id: Id, name: z.string(), desc: text })
export const Network = z.looseObject({
  _id: Id, name: z.string(), purpose: z.string(), vpn_type: text, enabled: flag,
  ip_subnet: text, vlan: z.number().int().nullish(), vlan_enabled: flag, wan_networkgroup: text,
})
export const Route = z.looseObject({
  _id: Id, description: text, enabled: z.boolean(), matching_target: z.string(),
  target_devices: z.array(Doc), network_id: text, next_hop: text, kill_switch_enabled: flag,
  domains: z.array(z.union([z.string(), Doc])).nullish(),
  ip_addresses: z.array(z.union([z.string(), Doc])).nullish(),
  ip_ranges: z.array(Doc).nullish(), regions: z.array(z.string()).nullish(),
  origin_type: z.unknown().optional(), predefined: flag,
})
export const Station = z.looseObject({
  mac: MacAddress, _id: text, name: text, hostname: text, oui: text, ip: text, fixed_ip: text,
  use_fixedip: flag, network: text, network_id: text, is_wired: flag, blocked: flag,
  ap_mac: text, sw_mac: text, sw_port: z.number().int().nullish(), essid: text, signal: number,
  first_seen: number, last_seen: number, rx_bytes: number, tx_bytes: number,
  'rx_bytes-r': number, 'tx_bytes-r': number,
})
// The v2 active endpoint varies by Network build. Keep its raw fields while normalizing common aliases.
export const ActiveStation = z.preprocess(input => {
  const value = Doc.safeParse(input).data
  if (!value) return input
  const traffic = Doc.safeParse(value.trafficUsage).data ?? {}
  return {
    ...value,
    mac: value.mac ?? value.macAddress,
    ip: value.ip ?? value.ipAddress,
    network_id: value.network_id ?? value.networkId,
    is_wired: value.is_wired ?? value.isWired ?? (value.connectionType === 'WIRED' ? true : undefined),
    ap_mac: value.ap_mac ?? value.apMac,
    sw_mac: value.sw_mac ?? value.switchMac,
    sw_port: value.sw_port ?? value.switchPort,
    essid: value.essid ?? value.ssid,
    first_seen: value.first_seen ?? value.firstSeen,
    last_seen: value.last_seen ?? value.lastSeen,
    rx_bytes: value.rx_bytes ?? traffic.rxBytes,
    tx_bytes: value.tx_bytes ?? traffic.txBytes,
    'rx_bytes-r': value['rx_bytes-r'] ?? traffic.rxBytesPerSecond,
    'tx_bytes-r': value['tx_bytes-r'] ?? traffic.txBytesPerSecond,
  }
}, Station)
export const Device = z.looseObject({
  mac: MacAddress, name: text, model: text, type: text, port_table: Docs.nullish(),
  wan1: Doc.nullish(), wan2: Doc.nullish(), wan3: Doc.nullish(),
  'rx_bytes-r': number, 'tx_bytes-r': number,
})
export const WlanDoc = z.looseObject({ _id: Id, name: z.string(), enabled: flag, security: text, is_guest: flag })
export const SystemLogPage = z.looseObject({ data: Docs, page_number: number, total_element_count: number, total_page_count: number })

export type WireDoc = z.infer<typeof Doc>
export type WireRoute = z.infer<typeof Route>
export type WireStation = z.infer<typeof Station>
export type WireNetwork = z.infer<typeof Network>
export type WireDevice = z.infer<typeof Device>
