import { MacAddress, type WireDevice, type WireDoc } from './endpoints/schemas'
import { isUplink, poeCapable, portIndex } from './poe-ports'
import type { DeviceUplink, InfraDevice, PortView, Radio } from '#shared/schemas/infra'
import type { z } from 'zod'

type Device = z.infer<typeof InfraDevice>
type Uplink = z.infer<typeof DeviceUplink>
type RadioView = z.infer<typeof Radio>
type PortFields = Omit<z.infer<typeof PortView>, 'peer' | 'poeSafety' | 'issues' | 'baselineSpeedMbps' | 'errorRatePct' | 'flaps1h'>

export const deviceMac = (value: unknown) => MacAddress.safeParse(value).data ?? null

export function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null
}

const int = (value: unknown) => {
  const numeric = finiteNumber(value)
  return numeric !== null && Number.isInteger(numeric) ? numeric : null
}
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null
const bool = (value: unknown) => typeof value === 'boolean' ? value : null
const gatewayTypes = new Set(['udm', 'ugw', 'uxg'])
const nonnegative = (value: unknown) => {
  const n = finiteNumber(value)
  return n !== null && n >= 0 ? n : null
}
const bps = (value: unknown) => {
  const bytes = nonnegative(value)
  return bytes === null ? null : finiteNumber(bytes * 8)
}

export function isGateway(device: WireDevice) {
  return gatewayTypes.has(device.type ?? '') && !device.is_access_point && !device.gateway_mac
    && (!!device.wan1 || !device.uplink?.uplink_mac)
}

export function deviceType(device: WireDevice): Device['type'] {
  if (device.is_access_point || device.type === 'uap' || device.device_mode_override === 'mesh') return 'ap'
  if (isGateway(device)) return 'gateway'
  if (device.type === 'usw') return 'switch'
  return 'other'
}

// UniFi reports 0 disconnected, 1 connected, 2 pending adoption, 3 firmware mismatch,
// 4 upgrading, 5 provisioning, 6 heartbeat missed, 7 adopting, and 8 deleting.
const states: Readonly<Record<number, Device['state']>> = {
  0: 'offline', 1: 'online', 2: 'adopting', 4: 'upgrading', 5: 'provisioning', 6: 'offline', 7: 'adopting',
}
export function deviceState(device: WireDevice): Device['state'] {
  if (device.restarting === true) return 'restarting'
  return device.state == null ? 'unknown' : states[device.state] ?? 'unknown'
}

export function deviceUplink(device: WireDevice): Uplink | null {
  const uplink = device.uplink ?? device.last_uplink
  if (!uplink) return null
  const kind = uplink.type?.toLowerCase()
  return {
    mac: deviceMac(uplink.uplink_mac), name: text(uplink.uplink_device_name),
    remotePort: portIndex(uplink.uplink_remote_port), localPort: portIndex(uplink.port_idx),
    type: kind === 'wire' || kind === 'wired' ? 'wire' : kind === 'wireless' || kind === 'mesh' || kind === 'wifi' ? 'wireless' : 'unknown',
    speedMbps: nonnegative(uplink.speed), fullDuplex: bool(uplink.full_duplex),
    signal: finiteNumber(uplink.signal), rxBps: bps(uplink['rx_bytes-r']), txBps: bps(uplink['tx_bytes-r']),
  }
}

const bands: Record<string, RadioView['band']> = { ng: '2.4', na: '5', '6e': '6', ad: '60' }

export function deviceRadios(device: WireDevice): RadioView[] {
  const radios = new Map<string, { config?: WireDoc, stats?: WireDoc }>()
  for (const [kind, docs] of [['config', device.radio_table], ['stats', device.radio_table_stats]] as const) {
    for (const doc of docs ?? []) {
      const key = text(doc.name) ?? text(doc.radio)
      if (key) radios.set(key, { ...radios.get(key), [kind]: doc })
    }
  }
  return [...radios.values()].map(({ config, stats }) => {
    const radio = text(stats?.radio ?? config?.radio)
    const utilizationPct = nonnegative(stats?.cu_total)
    const ownRx = nonnegative(stats?.cu_self_rx)
    const ownTx = nonnegative(stats?.cu_self_tx)
    return {
      radio, band: radio ? bands[radio] ?? 'unknown' : 'unknown',
      channel: int(stats?.channel) ?? int(config?.channel), widthMhz: int(stats?.bw) ?? int(config?.ht),
      txPowerDbm: finiteNumber(stats?.tx_power) ?? finiteNumber(config?.tx_power), utilizationPct,
      interferencePct: nonnegative(stats?.cu_interf) ?? (utilizationPct !== null && ownRx !== null && ownTx !== null
        ? Math.max(0, utilizationPct - ownRx - ownTx) : null),
      retriesPct: nonnegative(stats?.tx_retries_pct), clients: int(stats?.num_sta),
      satisfaction: nonnegative(stats?.satisfaction),
    }
  })
}

function maxSpeed(port: WireDoc) {
  const mask = int(port.speed_caps)
  const speeds = [10, 10, 100, 100, 1000, 1000, 2500, 5000, 10000]
  const supported = speeds.filter((_, index) => mask !== null && mask >= 0 && (mask & (1 << index)) !== 0)
  const explicit = Array.isArray(port.speeds) ? port.speeds.flatMap(value => nonnegative(value) ?? []) : []
  return supported.at(-1) ?? (explicit.length ? Math.max(...explicit) : null)
}

export function normalizePort(device: WireDevice, port: WireDoc): PortFields | null {
  const idx = portIndex(port.port_idx)
  if (idx === null) return null
  const capable = poeCapable(port)
  const media = String(port.media ?? '').toLowerCase()
  const poeOverride = device.port_overrides?.find(item => portIndex(item.port_idx) === idx)
  return {
    switchMac: device.mac, idx, name: text(port.name),
    media: media.includes('qsfp') ? 'qsfp' : media.includes('sfp28') ? 'sfp28'
      : media.includes('sfp+') || media.includes('sfpplus') ? 'sfp+'
        : media.includes('sfp') || port.sfp_found === true ? 'sfp'
          : /(?:ge|base-t|rj45|copper)/.test(media) || capable ? 'rj45' : 'unknown',
    enabled: bool(port.enable ?? port.enabled) ?? true, up: bool(port.up) ?? false,
    speedMbps: nonnegative(port.speed), maxSpeedMbps: maxSpeed(port),
    fullDuplex: bool(port.full_duplex), isUplink: isUplink(device, port),
    rxBps: bps(port['rx_bytes-r']), txBps: bps(port['tx_bytes-r']), stp: text(port.stp_state),
    poe: capable ? {
      capable, mode: text(port.poe_mode ?? poeOverride?.poe_mode), powerW: nonnegative(port.poe_power),
      poeClass: text(port.poe_class), scheduleId: null, heldOffByUnifire: false,
    } : null,
  }
}

export function deviceName(device: WireDevice) {
  return text(device.name) ?? text(device.model_name) ?? text(device.shortname) ?? text(device.model) ?? device.mac
}

export function normalizeDevice(device: WireDevice) {
  const uplink = deviceUplink(device)
  const ports = (device.port_table ?? []).flatMap(port => normalizePort(device, port) ?? [])
  const poePorts = ports.filter(port => port.poe?.capable)
  const powers = poePorts.flatMap(port => port.poe?.powerW ?? [])
  const temps = (device.temperatures ?? []).flatMap(temp => finiteNumber(temp.value) ?? [])
  const radios = deviceRadios(device)
  return {
    mac: device.mac, unifiId: text(device._id), name: deviceName(device), model: text(device.model),
    modelName: text(device.model_name) ?? text(device.shortname),
    type: deviceType(device), state: deviceState(device), ip: text(device.ip),
    firmware: text(device.version), upgradeTo: device.upgradable === false ? null : text(device.upgrade_to_firmware),
    uptimeSec: nonnegative(device.uptime) ?? nonnegative(device['system-stats']?.uptime),
    cpuPct: nonnegative(device['system-stats']?.cpu), memPct: nonnegative(device['system-stats']?.mem),
    tempC: finiteNumber(device.general_temperature) ?? (temps.length ? Math.max(...temps) : null),
    clients: int(device.num_sta), rxBps: bps(device['rx_bytes-r']) ?? uplink?.rxBps ?? null,
    txBps: bps(device['tx_bytes-r']) ?? uplink?.txBps ?? null, uplink,
    ports: ports.length ? { total: ports.length, up: ports.filter(port => port.up).length, poe: poePorts.length, issues: 0 } : null,
    poe: poePorts.length ? { usedW: nonnegative(device.total_used_power) ?? (powers.length ? powers.reduce((sum, watts) => sum + watts, 0) : null),
      budgetW: nonnegative(device.total_max_power) } : null,
    bands: [...new Set(radios.map(radio => radio.band).filter(band => band !== 'unknown'))],
  } satisfies Omit<Device, 'firstSeen' | 'lastSeen' | 'roomId' | 'availability24h' | 'lastReboot' | 'locating' | 'issues'>
}
