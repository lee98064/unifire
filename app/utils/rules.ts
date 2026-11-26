import type { RuleActionT, RuleConditionT, RuleTriggerT } from '#shared/schemas/automation'

/** Field kinds the generic rule block editor knows how to render. */
export type FieldKind =
  | 'macs' | 'mac' | 'person' | 'personOpt' | 'group' | 'egressOpt' | 'egress' | 'route' | 'quotaOpt' | 'cron' | 'tz'
  | 'number' | 'minutes' | 'minutesOpt' | 'bytes' | 'text' | 'textarea' | 'days' | 'time' | 'bool'
  | 'channels' | 'wlan' | 'wol' | 'switchport' | 'method' | 'target' | 'scope' | 'url' | 'headers'

export interface FieldSpec { key: string, kind: FieldKind, required?: boolean }
export interface BlockSpec<T> { icon: string, tone: string, fields: FieldSpec[], defaults: () => T }

type TriggerType = RuleTriggerT['type']
type ConditionType = RuleConditionT['type']
type ActionType = RuleActionT['type']

export const triggerSpecs: Record<TriggerType, BlockSpec<RuleTriggerT>> = {
  'client.connected': { icon: 'i-lucide-log-in', tone: 'success', fields: [{ key: 'macs', kind: 'macs' }, { key: 'personId', kind: 'personOpt' }], defaults: () => ({ type: 'client.connected', macs: [], personId: null }) },
  'client.disconnected': { icon: 'i-lucide-log-out', tone: 'neutral', fields: [{ key: 'macs', kind: 'macs' }, { key: 'personId', kind: 'personOpt' }], defaults: () => ({ type: 'client.disconnected', macs: [], personId: null }) },
  'client.new': { icon: 'i-lucide-sparkle', tone: 'warning', fields: [], defaults: () => ({ type: 'client.new' }) },
  'person.arrived': { icon: 'i-lucide-house', tone: 'success', fields: [{ key: 'personId', kind: 'personOpt' }], defaults: () => ({ type: 'person.arrived', personId: null }) },
  'person.left': { icon: 'i-lucide-door-open', tone: 'neutral', fields: [{ key: 'personId', kind: 'personOpt' }], defaults: () => ({ type: 'person.left', personId: null }) },
  'schedule': { icon: 'i-lucide-alarm-clock', tone: 'primary', fields: [{ key: 'cron', kind: 'cron', required: true }, { key: 'timezone', kind: 'tz' }], defaults: () => ({ type: 'schedule', cron: '0 22 * * *', timezone: 'Asia/Taipei' }) },
  'egress.down': { icon: 'i-lucide-cloud-off', tone: 'error', fields: [{ key: 'egressId', kind: 'egressOpt' }], defaults: () => ({ type: 'egress.down', egressId: null }) },
  'egress.up': { icon: 'i-lucide-cloud', tone: 'success', fields: [{ key: 'egressId', kind: 'egressOpt' }], defaults: () => ({ type: 'egress.up', egressId: null }) },
  'egress.ip_changed': { icon: 'i-lucide-map-pin', tone: 'warning', fields: [{ key: 'egressId', kind: 'egressOpt' }], defaults: () => ({ type: 'egress.ip_changed', egressId: null }) },
  'quota.warning': { icon: 'i-lucide-hourglass', tone: 'warning', fields: [{ key: 'quotaId', kind: 'quotaOpt' }], defaults: () => ({ type: 'quota.warning', quotaId: null }) },
  'quota.exceeded': { icon: 'i-lucide-octagon-x', tone: 'error', fields: [{ key: 'quotaId', kind: 'quotaOpt' }], defaults: () => ({ type: 'quota.exceeded', quotaId: null }) },
  'device.offline': { icon: 'i-lucide-unplug', tone: 'error', fields: [{ key: 'mac', kind: 'mac', required: true }, { key: 'minutes', kind: 'minutes' }], defaults: () => ({ type: 'device.offline', mac: '', minutes: 5 }) as RuleTriggerT },
  'traffic.threshold': { icon: 'i-lucide-gauge', tone: 'vpn', fields: [{ key: 'scope', kind: 'scope', required: true }, { key: 'bytes', kind: 'bytes' }, { key: 'windowMinutes', kind: 'minutes' }], defaults: () => ({ type: 'traffic.threshold', scope: { type: 'person', id: '' }, bytes: 1e9, windowMinutes: 60 }) },
}

export const conditionSpecs: Record<ConditionType, BlockSpec<RuleConditionT>> = {
  'time': { icon: 'i-lucide-clock', tone: 'primary', fields: [{ key: 'days', kind: 'days' }, { key: 'start', kind: 'time' }, { key: 'end', kind: 'time' }], defaults: () => ({ type: 'time', days: [0, 1, 2, 3, 4], start: '08:00', end: '18:00' }) },
  'person.home': { icon: 'i-lucide-house', tone: 'success', fields: [{ key: 'personId', kind: 'person', required: true }, { key: 'home', kind: 'bool' }], defaults: () => ({ type: 'person.home', personId: '', home: true }) },
  'anyone.home': { icon: 'i-lucide-users', tone: 'success', fields: [{ key: 'home', kind: 'bool' }], defaults: () => ({ type: 'anyone.home', home: false }) },
  'egress.health': { icon: 'i-lucide-heart-pulse', tone: 'vpn', fields: [{ key: 'egressId', kind: 'egress', required: true }, { key: 'healthy', kind: 'bool' }], defaults: () => ({ type: 'egress.health', egressId: '', healthy: true }) },
  'client.online': { icon: 'i-lucide-wifi', tone: 'primary', fields: [{ key: 'mac', kind: 'mac', required: true }, { key: 'online', kind: 'bool' }], defaults: () => ({ type: 'client.online', mac: '', online: true }) as RuleConditionT },
}

export const actionSpecs: Record<ActionType, BlockSpec<RuleActionT>> = {
  'route.override': { icon: 'i-lucide-route', tone: 'primary', fields: [{ key: 'managedRouteId', kind: 'route', required: true }, { key: 'egressId', kind: 'egress', required: true }, { key: 'minutes', kind: 'minutes' }], defaults: () => ({ type: 'route.override', managedRouteId: '', egressId: '', minutes: 60 }) },
  'route.clear_override': { icon: 'i-lucide-route-off', tone: 'neutral', fields: [{ key: 'managedRouteId', kind: 'route', required: true }], defaults: () => ({ type: 'route.clear_override', managedRouteId: '' }) },
  'block': { icon: 'i-lucide-ban', tone: 'error', fields: [{ key: 'target', kind: 'target', required: true }, { key: 'minutes', kind: 'minutesOpt' }], defaults: () => ({ type: 'block', target: { type: 'person', id: '' }, minutes: 60 }) },
  'unblock': { icon: 'i-lucide-circle-check', tone: 'success', fields: [{ key: 'target', kind: 'target', required: true }], defaults: () => ({ type: 'unblock', target: { type: 'person', id: '' } }) },
  'pause': { icon: 'i-lucide-circle-pause', tone: 'warning', fields: [{ key: 'personId', kind: 'person', required: true }, { key: 'minutes', kind: 'minutesOpt' }], defaults: () => ({ type: 'pause', personId: '', minutes: 60 }) },
  'resume': { icon: 'i-lucide-play', tone: 'success', fields: [{ key: 'personId', kind: 'person', required: true }], defaults: () => ({ type: 'resume', personId: '' }) },
  'group.pause': { icon: 'i-lucide-users-round', tone: 'warning', fields: [{ key: 'groupId', kind: 'group', required: true }, { key: 'minutes', kind: 'minutesOpt' }], defaults: () => ({ type: 'group.pause', groupId: '', minutes: 60 }) },
  'group.resume': { icon: 'i-lucide-users-round', tone: 'success', fields: [{ key: 'groupId', kind: 'group', required: true }], defaults: () => ({ type: 'group.resume', groupId: '' }) },
  'notify': { icon: 'i-lucide-bell-ring', tone: 'primary', fields: [{ key: 'channelIds', kind: 'channels' }, { key: 'title', kind: 'text', required: true }, { key: 'body', kind: 'textarea' }], defaults: () => ({ type: 'notify', channelIds: [], title: '', body: '' }) },
  'webhook': { icon: 'i-lucide-webhook', tone: 'vpn', fields: [{ key: 'url', kind: 'url', required: true }, { key: 'method', kind: 'method' }, { key: 'headers', kind: 'headers' }, { key: 'body', kind: 'textarea' }], defaults: () => ({ type: 'webhook', url: '', method: 'POST', headers: {}, body: null }) },
  'poe.cycle': { icon: 'i-lucide-plug-zap', tone: 'warning', fields: [{ key: 'port', kind: 'switchport', required: true }], defaults: () => ({ type: 'poe.cycle', switchMac: '', portIdx: 1 }) as RuleActionT },
  'wlan.toggle': { icon: 'i-lucide-wifi', tone: 'primary', fields: [{ key: 'wlanId', kind: 'wlan', required: true }, { key: 'enabled', kind: 'bool' }], defaults: () => ({ type: 'wlan.toggle', wlanId: '', enabled: true }) },
  'wol': { icon: 'i-lucide-power', tone: 'success', fields: [{ key: 'targetId', kind: 'wol', required: true }], defaults: () => ({ type: 'wol', targetId: '' }) },
  'device.restart': { icon: 'i-lucide-rotate-cw', tone: 'warning', fields: [{ key: 'mac', kind: 'mac', required: true }], defaults: () => ({ type: 'device.restart', mac: '' }) as RuleActionT },
  'delay': { icon: 'i-lucide-hourglass', tone: 'neutral', fields: [{ key: 'seconds', kind: 'number' }], defaults: () => ({ type: 'delay', seconds: 30 }) },
}

export const toneClass: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
  vpn: 'bg-vpn/10 text-vpn',
  neutral: 'bg-(--uf-hover) text-toned',
}

/** Common cron presets for the schedule trigger. */
export const cronPresets = [
  { cron: '0 * * * *', key: 'everyHour' },
  { cron: '0 22 * * *', key: 'daily22' },
  { cron: '0 7 * * 1-5', key: 'weekday7' },
  { cron: '0 9 * * 6,0', key: 'weekend9' },
  { cron: '*/15 * * * *', key: 'every15' },
]
