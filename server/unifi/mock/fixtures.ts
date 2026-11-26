const wanNames = ['Fiber Static (WAN1)', 'Cable (WAN2)', 'LTE Backup (WAN3)']
const vpnNames = ['Tokyo WG', 'Osaka WG', 'Singapore WG', 'Frankfurt OVPN', 'Los Angeles OVPN',
  'Seoul WG', 'Taichung Home WG', 'Office WG']
const lanNames = ['Core', 'IoT', 'Guest', 'Kids', 'Lab']
export const MOCK_SITE = 'default'
export const MOCK_USERNAME = 'unifire-demo'
export const MOCK_PASSWORD = 'local-demo-only'
export const SELF_MAC = 'b8:27:eb:10:00:01'
const GATEWAY_MAC = '78:8a:20:90:00:01'
const SWITCH_MAC = '78:8a:20:90:00:02'
const AP1 = '78:8a:20:90:00:03'
const AP2 = '78:8a:20:90:00:04'
const egressId = (index: number) => index < 3 ? `demo-wan-${index + 1}` : `demo-vpn-${index - 2}`
const egressCountries = ['TW', 'TW', 'TW', 'JP', 'JP', 'SG', 'DE', 'US', 'KR', 'TW', 'TW']
const latencies = [6, 12, 41, 51, 54, 76, 207, 142, 59, 15, 19]

const endpoints = [
  ['unifire-lab', 'b8:27:eb'], ['alder-phone', '00:1c:b3'], ['cove-tab', '00:16:32'],
  ['field-pixel', '3c:5a:b4'], ['cedar-speaker', '00:0e:58'], ['atlas-nas', '00:11:32'],
  ['garden-sensor', '24:0a:c4'], ['sparrow-pi', 'b8:27:eb'], ['porch-camera', '78:8a:20'],
  ['orbit-switch', '00:09:bf'], ['river-console', '00:01:4a'], ['den-tv', '00:1c:62'],
  ['hall-air-monitor', '64:09:80'], ['maple-desktop', '00:1b:21'], ['juniper-phone', '02:25:30'],
  ['mesa-laptop', '00:1c:b3'], ['lemon-watch', '00:16:32'], ['eider-cast', '3c:5a:b4'],
  ['terrace-speaker', '00:0e:58'], ['acorn-nas', '00:11:32'], ['garage-sensor', '24:0a:c4'],
  ['ridge-pi', 'b8:27:eb'], ['workbench-camera', '78:8a:20'], ['cloud-switch', '00:09:bf'],
  ['oak-headset', '00:01:4a'], ['loft-display', '00:1c:62'], ['shed-thermostat', '64:09:80'],
  ['birch-laptop', '00:1b:21'], ['finch-phone', '06:25:30'], ['daybreak-tablet', '00:1c:b3'],
  ['harbor-monitor', '00:16:32'], ['islet-doorbell', '3c:5a:b4'], ['amber-pixel', '0a:25:30'],
  ['studio-sensor', '24:0a:c4'], ['glade-pi', 'b8:27:eb'],
] as const

export function buildFixtures(now: number, selfIp: string) {
  const networks = [
    ...wanNames.map((name, index) => ({
      _id: egressId(index), name, purpose: 'wan', enabled: true, site_id: 'demo-site',
      wan_networkgroup: index === 0 ? 'WAN' : `WAN${index + 1}`,
      wan_type: index === 0 ? 'static' : 'dhcp',
      wan_failover_priority: index + 1, routing_table_id: 200 + index, vlan_enabled: false,
      wan_provider_capabilities: { download_kilobits_per_second: 500000 / (index + 1), upload_kilobits_per_second: 100000 / (index + 1) },
    })),
    ...vpnNames.map((name, index) => ({
      _id: egressId(index + 3), name, purpose: 'vpn-client', enabled: true, site_id: 'demo-site',
      vpn_type: name.endsWith('WG') ? 'wireguard-client' : 'openvpn-client',
      ip_subnet: `10.234.${index}.2/32`, routing_table_id: 220 + index, vlan_enabled: false,
      ...(name.endsWith('WG') ? { wireguard_client_peer_ip: `203.0.113.${51 + index}`, wireguard_client_peer_port: 51820 }
        : { openvpn_configuration_status: 'configured', openvpn_configuration_filename: 'demo.ovpn' }),
    })),
    ...lanNames.map((name, index) => ({
      _id: `demo-lan-${index}`, name, purpose: name === 'Guest' ? 'guest' : 'corporate', enabled: true,
      site_id: 'demo-site', ip_subnet: `10.235.${index}.1/24`, vlan: index * 10, vlan_enabled: index > 0,
      dhcpd_enabled: true, dhcpd_start: `10.235.${index}.20`, dhcpd_stop: `10.235.${index}.199`,
    })),
  ]
  const clients = endpoints.map(([hostname, prefix], index) => {
    const wired = index % 3 === 0 || [5, 8, 13, 19, 22].includes(index)
    const network = index < 2 ? 0 : index % 5
    const last = (index + 1).toString(16).padStart(2, '0')
    const ip = index === 0 ? selfIp : `10.235.${network}.${20 + index}`
    return {
      _id: `demo-client-${index}`, mac: `${prefix}:10:00:${last}`, hostname, ip,
      name: index === 0 ? 'Unifire demo host' : undefined,
      network_id: `demo-lan-${network}`, network: lanNames[network], blocked: false,
      use_fixedip: wired, fixed_ip: wired ? ip : undefined, is_wired: wired, online: index < 29,
      ...(wired ? { sw_mac: SWITCH_MAC, sw_port: index % 22 + 1 }
        : { ap_mac: index % 2 ? AP1 : AP2, essid: network === 1 ? 'IoT' : network === 2 ? 'Guest' : 'Home', signal: -42 - index }),
      first_seen: Math.floor(now / 1000) - 86400 * (35 - index), last_seen: Math.floor(now / 1000) - (index < 29 ? 0 : 1800),
      rx_bytes: index * 45_000, tx_bytes: index * 18_000, 'rx_bytes-r': index * 125, 'tx_bytes-r': index * 42,
    }
  })
  const devices = [
    {
      mac: GATEWAY_MAC, name: 'Dream Machine Pro', model: 'UDMPRO', type: 'udm',
      wan1: { up: true, ip: '198.51.100.11', 'rx_bytes-r': 105_000, 'tx_bytes-r': 30_000 },
      wan2: { up: true, ip: '198.51.100.12', 'rx_bytes-r': 21_000, 'tx_bytes-r': 8_000 },
      wan3: { up: true, ip: '198.51.100.13', 'rx_bytes-r': 2_000, 'tx_bytes-r': 420 },
      'rx_bytes-r': 128_000, 'tx_bytes-r': 38_420,
    },
    { mac: SWITCH_MAC, name: 'Studio Switch', model: 'USW-Pro-24-PoE', type: 'usw', port_table: Array.from({ length: 24 }, (_, index) => ({
      port_idx: index + 1, name: `Port ${index + 1}`, up: index < 15 || index === 23,
      port_poe: index < 16, poe_mode: index < 16 ? 'auto' : 'off',
      poe_power: index < 7 ? (index * 0.7 + 2.2).toFixed(1) : '0.0', is_uplink: index === 23,
    })) },
    { mac: AP1, name: 'U7 Pro', model: 'U7-Pro', type: 'uap' },
    { mac: AP2, name: 'U6 Lite', model: 'U6-Lite', type: 'uap' },
  ]
  const descriptions = ['Example hourly egress', 'Console traffic', 'Studio streaming', 'Lab updates', 'Family devices',
    'Guest streaming', 'Work VPN', 'Storage sync', 'IoT region rule', 'Research browser', 'Music services',
    'School devices', 'Demo testing', 'Maintenance window', 'Home relay', 'Test egress',
    'Object lab', 'Object media', 'Object office', 'Default uplink policy']
  const routes = descriptions.map((description, index) => {
    const match = (['INTERNET', 'DOMAIN', 'IP', 'REGION'] as const)[index % 4]
    return {
      _id: `demo-route-${index + 1}`, description, enabled: index % 7 !== 6,
      matching_target: match, network_id: egressId(index % 11), next_hop: '', kill_switch_enabled: true,
      target_devices: [{ type: 'CLIENT', client_mac: clients[index + 1]?.mac ?? SELF_MAC }],
      domains: match === 'DOMAIN' ? [{ domain: 'media.example.test', ports: [443], port_ranges: [] }] : [],
      ip_addresses: match === 'IP' ? [{ ip_or_subnet: '203.0.113.0/27', ip_version: 'v4', ports: [], port_ranges: [] }] : [],
      ip_ranges: [], regions: match === 'REGION' ? ['JP', 'TW'] : [],
      ...(index >= 16 && index <= 18 ? { origin_type: 'object_pbr', origin_id: `demo-object-${index - 16}` } : {}),
      ...(index === 19 ? { predefined: true } : {}),
      demo_extension: { index, behavior: 'preserve-on-update' },
    }
  })
  const wlans = ['Home', 'IoT', 'Guest'].map((name, index) => ({
    _id: `demo-wlan-${index}`, name, enabled: true, security: index === 2 ? 'open' : 'wpapsk', is_guest: index === 2,
    networkconf_id: `demo-lan-${index}`, ...(index < 2 && { x_passphrase: 'fixture-only' }),
  }))
  return { networks, clients, routes, devices, wlans }
}

export function probeProfiles() {
  return new Map(latencies.map((latency, index) => [egressId(index), {
    latency, ip: `198.51.100.${11 + index}`, country: egressCountries[index] ?? 'TW',
  }]))
}

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 4_294_967_296
  }
}
