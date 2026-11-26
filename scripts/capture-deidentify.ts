import { isIP } from 'node:net'

const secretField = /pass|secret|token|psk|key$|auth|cookie|serial|license|anon_?id|device_?id|ssh|fingerprint/i
const privateField = /^(?:anonymous_controller_id|sso_app_id|credentials|certificate|ca_pem)$/i
const nameField = /^(?:(?:.*_)?(?:name|hostname|host_name|essid|ssid|desc|description|note|username|user_name|email|site|wlan|alias)|network|location|label)$/
const technicalField = /^(?:model|model_name|shortname|short_name|type|board_rev|board_revision|(?:.*_)?version|upgrade_to_firmware)$/
const freeTextField = /^(?:message|msg|event_string|event_message|error_message|reason_text)$/
const protocolKind = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)*$/i

const macPattern = /^(?:[0-9a-f]{2}(?<separator>[:-]))(?:[0-9a-f]{2}\k<separator>){4}[0-9a-f]{2}$/i
const word = String.raw`[\p{L}\p{N}_]`
// Match a whole address before distinguishing colon-separated MACs from IPv6.
const networkPatterns = [
  String.raw`(?:[\da-f]{2}-){5}[\da-f]{2}(?!${word})`,
  String.raw`\[[\da-f:.]+(?:%[\w.-]+)?\]`,
  String.raw`(?=[\da-f:.]*:[\da-f:.]*:)(?:[\da-f]|::)[\da-f:.]*(?:%[\w.-]+)?(?!${word})`,
  String.raw`(?:(?:[\p{L}\p{N}._%+-]+)@)?(?:[\p{L}\p{N}_-]+\.)+\p{L}[\p{L}\p{N}-]*(?![\p{L}\p{N}_-])`,
  String.raw`(?:\d{1,3}\.){3}\d{1,3}(?!${word}|\.\d)`,
  String.raw`(?<=://)(\p{L}[\p{L}\p{N}_-]*)(?=[:/?#\s]|$)`,
]
const networkToken = new RegExp(`(?<!${word})(?:${networkPatterns.join('|')})`, 'giu')

const REDACTED = '<redacted>'

export function normalizeMac(value: unknown) {
  return typeof value === 'string' && macPattern.test(value) ? value.toLowerCase().replaceAll('-', ':') : null
}

function ordinal(map: Map<string, number>, value: string) {
  const existing = map.get(value)
  if (existing !== undefined) return existing
  const next = map.size + 1
  map.set(value, next)
  return next
}

function pseudonyms(format: (index: number) => string) {
  const assigned = new Map<string, string>()
  let index = 0
  return (source: string) => {
    const existing = assigned.get(source)
    if (existing !== undefined) return existing
    let alias = format(++index)
    if (alias === source) alias = format(++index)
    assigned.set(source, alias)
    return alias
  }
}

function isPrivateIpv4(first: number, second: number) {
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168
}

function normalizeField(field: string) {
  return field.replace(/([a-z\d])([A-Z])/g, '$1_$2').replaceAll('-', '_').toLowerCase()
}

export function createDeidentifier() {
  const hosts = new Map<string, number>()
  const names = new Map<string, number>()
  const ids = new Map<string, number>()

  const pseudoMac = pseudonyms(index => {
    if (index > 0xffff) return REDACTED
    const suffix = index.toString(16).padStart(4, '0')
    return `02:00:00:00:${suffix.slice(0, 2)}:${suffix.slice(2)}`
  })
  const pseudoPrivateSubnet = pseudonyms(index => {
    const subnet = index - 1
    return subnet <= 0xffff ? `10.${Math.floor(subnet / 256)}.${subnet % 256}` : REDACTED
  })
  const pseudoPublicIp = pseudonyms(index => index < 255 ? `203.0.113.${index}` : REDACTED)
  const pseudoIpv6 = pseudonyms(index => {
    const low = (index % 0x10000).toString(16)
    const high = Math.floor(index / 0x10000).toString(16)
    return index < 0x10000 ? `2001:db8::${low}` : `2001:db8::${high}:${low}`
  })

  function pseudoIp(value: string, family: number) {
    if (family === 6) {
      const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
      return pseudoIpv6(canonical)
    }

    const octets = value.split('.')
    if (isPrivateIpv4(Number(octets[0]), Number(octets[1]))) {
      const subnet = pseudoPrivateSubnet(octets.slice(0, 3).join('.'))
      return subnet === REDACTED ? REDACTED : `${subnet}.${octets[3]}`
    }
    return pseudoPublicIp(value)
  }

  function replaceToken(token: string, singleLabelHost?: string) {
    const bare = token.replace(/\.+$/, '').replace(/(?<!:):$/, '')
    const suffix = token.slice(bare.length)
    const mac = normalizeMac(bare)
    if (mac) return `${pseudoMac(mac)}${suffix}`

    const bracketed = bare.startsWith('[') && bare.endsWith(']')
    const unwrapped = bracketed ? bare.slice(1, -1) : bare
    const ip = unwrapped.split('%')[0] ?? ''
    const family = isIP(ip)
    if (family) {
      const replacement = pseudoIp(ip, family)
      return `${bracketed ? `[${replacement}]` : replacement}${suffix}`
    }

    const host = bare.slice(bare.lastIndexOf('@') + 1)
    if (singleLabelHost || host.includes('.') && !host.includes(':') && /\.\p{L}[\p{L}\p{N}-]*$/u.test(host)) {
      const alias = `host-${ordinal(hosts, host.toLowerCase())}.example`
      return `${host === bare ? '' : `${REDACTED}@`}${alias}${suffix}`
    }
    return token
  }

  const text = (value: string) => value.replace(networkToken, replaceToken)

  function label(value: string, field: string) {
    return `${field}-${ordinal(names, value)}`
  }

  function kind(value: string, field: 'message' | 'event') {
    const sanitized = text(value)
    if (sanitized !== value) return sanitized
    const knownFormat = field === 'event' ? /^EVT_[a-z0-9_]+$/i.test(value) : protocolKind.test(value)
    return knownFormat ? value : label(value, field)
  }

  function scrubString(value: string, field = ''): string {
    if (!value) return value
    const normalized = normalizeField(field)
    if (technicalField.test(normalized)) return value
    if (nameField.test(normalized) && normalized !== 'domain_name' && !normalizeMac(value) && !isIP(value)) {
      return label(value, field)
    }
    if (freeTextField.test(normalized)) {
      const addresses = [...value.matchAll(networkToken)].flatMap(([token, singleLabelHost]) => {
        if (!token) return []
        const replacement = replaceToken(token, singleLabelHost)
        return replacement === token ? [] : [replacement]
      })
      return [label(value, field), ...addresses].join(' ')
    }
    const sanitized = text(value)
    if (sanitized !== value) return sanitized
    if (/^(?:id|.*_id)$/.test(normalized)) return `id-${ordinal(ids, value)}`
    if (/^(?:user|admin|admin_user|operator)$/.test(normalized)) return label(value, field)
    return value
  }

  function walk(value: unknown, field: string | undefined, frameMeta: boolean): unknown {
    if (Array.isArray(value)) return value.map(entry => walk(entry, field, false))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        if (/^x_/i.test(key)) return []
        const normalized = normalizeField(key)
        const scrubbed = secretField.test(key) || privateField.test(normalized) ? REDACTED
          : frameMeta && key === 'message' && typeof entry === 'string' ? kind(entry, 'message')
          : walk(entry, key, key === 'meta')
        return [[text(key), scrubbed]]
      }))
    }
    return typeof value === 'string' ? scrubString(value, field) : value
  }

  return { value: (value: unknown) => walk(value, undefined, false), string: scrubString, pseudoMac, kind }
}
