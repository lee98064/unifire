import type { DeviceStateT, DeviceTypeT, InfraDeviceT, PortViewT } from '#shared/schemas/infra'

export const deviceTypeIcon: Record<DeviceTypeT, string> = {
  gateway: 'i-lucide-router',
  switch: 'i-lucide-ethernet-port',
  ap: 'i-lucide-wifi',
  other: 'i-lucide-box',
}

export const deviceTypeOrder: DeviceTypeT[] = ['gateway', 'switch', 'ap', 'other']

/** StatusDot status for a device state. */
export function deviceDot(state: DeviceStateT): 'healthy' | 'degraded' | 'down' | 'unknown' {
  if (state === 'online') return 'healthy'
  if (state === 'offline') return 'down'
  if (state === 'unknown') return 'unknown'
  return 'degraded'
}

/** Busy states get a spinner instead of a plain dot. */
export const busyStates: DeviceStateT[] = ['restarting', 'upgrading', 'provisioning', 'adopting']

/** Visual family used by DeviceGlyph — not the same as type (an Express is an AP that looks like a cube). */
export type GlyphShape = 'rack' | 'switch' | 'flex' | 'disc' | 'cube' | 'box'
export function glyphShape(d: Pick<InfraDeviceT, 'type' | 'model'>): GlyphShape {
  const m = (d.model ?? '').toUpperCase()
  if (d.type === 'gateway') return 'rack'
  if (m.startsWith('UDMA') || m.startsWith('UX')) return 'cube'
  if (d.type === 'ap') return 'disc'
  if (d.type === 'switch') return /^USW?ED|FLEX|USMINI|USF/.test(m) ? 'flex' : 'switch'
  return 'box'
}

/* ───────── link speed colours (shared by faceplate, topology, tables) ───────── */

export type SpeedTier = 'down' | 'slow' | 'gig' | 'multi' | 'ten'
export function speedTier(mbps: number | null | undefined, up = true): SpeedTier {
  if (!up || !mbps) return 'down'
  if (mbps < 1000) return 'slow'
  if (mbps < 2500) return 'gig'
  if (mbps < 10000) return 'multi'
  return 'ten'
}
export const speedColor: Record<SpeedTier, string> = {
  down: 'var(--ui-border-accented)',
  slow: '#F5A524',
  gig: '#38CC65',
  multi: '#006FFF',
  ten: '#8E59FF',
}
export function speedLabel(mbps: number | null | undefined): string {
  if (!mbps) return '—'
  if (mbps >= 1000) return `${Number.isInteger(mbps / 1000) ? mbps / 1000 : (mbps / 1000).toFixed(1)}G`
  return `${mbps}M`
}

/** Threshold colour for meters (cpu / mem / temp). */
export function meterTone(value: number | null | undefined, warn: number, crit: number): 'success' | 'warning' | 'error' | 'neutral' {
  if (value == null) return 'neutral'
  if (value >= crit) return 'error'
  if (value >= warn) return 'warning'
  return 'success'
}

/** Custom port name, or null when it is just UniFi's default "Port N". */
export function portName(p: Pick<PortViewT, 'name' | 'idx'>): string | null {
  if (!p.name) return null
  return new RegExp(`^port\\s*${p.idx}$`, 'i').test(p.name.trim()) ? null : p.name
}

export function portIsPoeOn(p: PortViewT) {
  return !!p.poe?.capable && p.poe.mode !== 'off' && (p.poe.powerW ?? 0) > 0
}

/** Human uptime: "12d 4h" / "3h 12m" / "8m". */
export function uptimeShort(sec: number | null | undefined, t: (k: string, p?: Record<string, unknown>) => string): string {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return t('devices.uptimeDH', { d, h })
  if (h) return t('devices.uptimeHM', { h, m })
  return t('devices.uptimeM', { m: Math.max(m, 0) })
}

/** Sort devices like the UniFi device list: gateway → switches → APs, then by name. */
export function compareDevices(a: InfraDeviceT, b: InfraDeviceT) {
  return deviceTypeOrder.indexOf(a.type) - deviceTypeOrder.indexOf(b.type) || a.name.localeCompare(b.name)
}
