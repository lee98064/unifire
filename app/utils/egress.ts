import type { EgressKindT, HealthStatusT } from '#shared/schemas/egress'

export const egressKindIcon: Record<EgressKindT, string> = {
  wan: 'i-lucide-cable',
  wireguard: 'i-lucide-shield',
  openvpn: 'i-lucide-lock-keyhole',
  other: 'i-lucide-circle-dashed',
}

export const healthColor: Record<HealthStatusT, string> = {
  healthy: 'var(--color-ufgreen-500)',
  degraded: 'var(--color-ufamber-500)',
  down: 'var(--color-ufred-500)',
  unknown: 'var(--color-ufgray-500)',
}

export const healthUi: Record<HealthStatusT, 'success' | 'warning' | 'error' | 'neutral'> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'error',
  unknown: 'neutral',
}

/** Latency → color ramp used on rings and sparklines. */
export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return healthColor.unknown
  if (ms < 40) return 'var(--color-ufgreen-500)'
  if (ms < 120) return 'var(--color-unifi-400)'
  if (ms < 250) return 'var(--color-ufamber-500)'
  return 'var(--color-ufred-500)'
}

/** Fallback identity palette (server assigns colors; UI uses this for unknown ids). */
export const identityPalette = ['#006FFF', '#38CC65', '#8E59FF', '#F5A524', '#00B8D9', '#FF5C8A', '#14B8A6', '#F97316', '#6366F1', '#84CC16', '#E879F9', '#0EA5E9']

/** Readable text color on top of a hex background. */
export function onColor(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#131416' : '#ffffff'
}

export function countryIcon(cc: string | null | undefined): string | null {
  return cc ? `i-circle-flags-${cc.toLowerCase()}` : null
}
