import { getRequestHeader, type H3Event } from 'h3'
import type { GuestWifiT } from '#shared/schemas/automation'

export function forwardedOrigin(proto: string | undefined, host: string | undefined) {
  if ((proto !== 'https' && proto !== 'http') || !host || !/^(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::\d+)?$/i.test(host)) return undefined
  try { return new URL(`${proto}://${host}`).origin } catch { return undefined }
}

export function trustedProxyOrigin(event: H3Event) {
  if (String(useRuntimeConfig(event).trustProxy) !== 'true') return undefined
  return forwardedOrigin(getRequestHeader(event, 'x-forwarded-proto'), getRequestHeader(event, 'x-forwarded-host'))
}

export function guestWifiWithProxyUrl(event: H3Event, wifi: GuestWifiT): GuestWifiT {
  const origin = trustedProxyOrigin(event)
  return origin && wifi.kioskUrl?.startsWith('/kiosk/') ? { ...wifi, kioskUrl: new URL(wifi.kioskUrl, origin).href } : wifi
}
