import type { AuditEventT } from '#shared/schemas/insight'
import { isSecretKey, REDACTED } from '../utils/redact'

/**
 * Network 11 system-log rows carry a structured event code (`key`, e.g. CLIENT_…), a fixed English template
 * (`message_raw` with {PLACEHOLDER}s, `title_raw`) and the structured objects it refers to (`parameters`).
 * Older controllers used `EVT_*` keys. Free-form prose fields (`message`, `msg`) are never used, because UniFi
 * can interpolate controller data into them; only the template plus parameter names/ids are rendered.
 */
const LEGACY_KEY = /^EVT_[A-Za-z0-9_]{1,80}$/
const KEY = /^[A-Z][A-Z0-9_]{1,80}$/
const PLACEHOLDER = /\{([A-Z][A-Z0-9_]{0,40})\}/g
const MAX_MESSAGE = 240

type Row = Record<string, unknown>
type Target = NonNullable<AuditEventT['target']>

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
const text = (value: unknown, max = MAX_MESSAGE) => typeof value === 'string' && clean(value) ? clean(value).slice(0, max) : null
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null

function label(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return text(value, 80)
  const object = record(value)
  return object ? text(object.name, 80) ?? text(object.hostname, 80) ?? text(object.id, 80) : null
}

function severity(value: unknown): AuditEventT['severity'] {
  const code = typeof value === 'string' ? value.toUpperCase() : ''
  if (/^(CRITICAL|VERY_HIGH|ERROR)$/.test(code)) return 'error'
  if (/^(HIGH|WARNING|WARN)$/.test(code)) return 'warning'
  return 'info'
}

function target(parameters: Row): Target | null {
  for (const [name, type] of [['CLIENT', 'client'], ['DEVICE', 'device']] as const) {
    const object = record(parameters[name])
    const id = text(object?.id, 80)
    if (id) return { type, id, label: label(object) ?? id }
  }
  return null
}

export function describeSystemLog(row: Row) {
  const rawKey = row.key ?? row.eventKey ?? row.event_key
  const key = typeof rawKey === 'string' && (LEGACY_KEY.test(rawKey) || KEY.test(rawKey)) ? rawKey : 'unifi.event'
  const parameters = record(row.parameters) ?? {}
  const template = text(row.message_raw, 400)
  const rendered = template
    ? text(template.replace(PLACEHOLDER, (placeholder, name: string) => isSecretKey(name) ? REDACTED : label(parameters[name]) ?? placeholder))
    : null
  const title = text(row.title_raw, 120)
  const message = rendered ?? title ?? (key === 'unifi.event' ? REDACTED : key)
  return {
    key,
    message,
    title: title ?? '',
    category: text(row.category, 40) ?? '',
    severity: severity(row.severity),
    target: target(parameters),
  }
}
