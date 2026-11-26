import type { WireDevice, WireDoc } from './endpoints/schemas'
import { UnifiError } from './errors'

function truthy(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function portIndex(value: unknown) {
  const index = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof index === 'number' && Number.isSafeInteger(index) && index > 0 ? index : null
}

export function poeCapable(port: WireDoc) {
  return truthy(port.port_poe) || truthy(port.poe_capable) || truthy(port.poe_enable)
    || ['auto', 'pasv24', 'passthrough'].includes(String(port.poe_mode))
}

export function isUplink(device: WireDevice, port: WireDoc) {
  const index = portIndex(port.port_idx)
  const uplink = device.uplink
  const uplinkIndex = uplink && typeof uplink === 'object' && 'port_idx' in uplink ? portIndex(uplink.port_idx) : null
  return truthy(port.is_uplink) || truthy(port.uplink) || truthy(port.is_wan)
    || /^(uplink|wan)/i.test(String(port.port_type ?? ''))
    || index !== null && (index === uplinkIndex || index === portIndex(device.uplink_port))
}

export function assertPoePort(devices: WireDevice[], mac: string, index: number) {
  const device = devices.find(item => item.mac === mac)
  const port = device?.port_table?.find(item => portIndex(item.port_idx) === index)
  if (!device || !port || !poeCapable(port) || isUplink(device, port)) throw new UnifiError('UNSAFE_POE_PORT', 409)
  return device
}
