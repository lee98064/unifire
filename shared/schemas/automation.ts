import { z } from 'zod'
import { HHMM, Id, Mac, Ts, Weekday } from './common'

/* ───────────────────────────── Rule engine ───────────────────────────── */

export const RuleTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('client.connected'), macs: z.array(Mac).default([]), personId: Id.nullable().default(null) }),
  z.object({ type: z.literal('client.disconnected'), macs: z.array(Mac).default([]), personId: Id.nullable().default(null) }),
  z.object({ type: z.literal('client.new') }),
  z.object({ type: z.literal('person.arrived'), personId: Id.nullable().default(null) }),
  z.object({ type: z.literal('person.left'), personId: Id.nullable().default(null) }),
  z.object({ type: z.literal('schedule'), cron: z.string().min(1), timezone: z.string().default('Asia/Taipei') }),
  z.object({ type: z.literal('egress.down'), egressId: Id.nullable().default(null) }),
  z.object({ type: z.literal('egress.up'), egressId: Id.nullable().default(null) }),
  z.object({ type: z.literal('egress.ip_changed'), egressId: Id.nullable().default(null) }),
  z.object({ type: z.literal('quota.warning'), quotaId: Id.nullable().default(null) }),
  z.object({ type: z.literal('quota.exceeded'), quotaId: Id.nullable().default(null) }),
  /** A UniFi device or client unseen for N minutes. */
  z.object({ type: z.literal('device.offline'), mac: Mac, minutes: z.number().int().min(1).max(1440).default(5) }),
  /** Bytes transferred by client/person within a sliding window. */
  z.object({
    type: z.literal('traffic.threshold'),
    scope: z.object({ type: z.enum(['client', 'person']), id: z.string() }),
    bytes: z.number().positive(),
    windowMinutes: z.number().int().min(1).max(1440),
  }),
])

export const RuleCondition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('time'), days: z.array(Weekday).min(1), start: HHMM, end: HHMM }),
  z.object({ type: z.literal('person.home'), personId: Id, home: z.boolean() }),
  z.object({ type: z.literal('anyone.home'), home: z.boolean() }),
  z.object({ type: z.literal('egress.health'), egressId: Id, healthy: z.boolean() }),
  z.object({ type: z.literal('client.online'), mac: Mac, online: z.boolean() }),
])

const ClientOrPerson = z.object({ type: z.enum(['client', 'person', 'group']), id: z.string() })

export const RuleAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('route.override'), managedRouteId: Id, egressId: Id, minutes: z.number().int().min(1).max(10080) }),
  z.object({ type: z.literal('route.clear_override'), managedRouteId: Id }),
  z.object({ type: z.literal('block'), target: ClientOrPerson, minutes: z.number().int().min(1).nullable().default(null) }),
  z.object({ type: z.literal('unblock'), target: ClientOrPerson }),
  z.object({ type: z.literal('pause'), personId: Id, minutes: z.number().int().min(1).nullable().default(60) }),
  z.object({ type: z.literal('resume'), personId: Id }),
  /** Message supports {{placeholders}} from the trigger event. */
  z.object({ type: z.literal('notify'), channelIds: z.array(Id).default([]), title: z.string().min(1), body: z.string().default('') }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT']).default('POST'),
    headers: z.record(z.string(), z.string()).default({}),
    /** JSON template; {{event}} injects the trigger event. */
    body: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal('poe.cycle'), switchMac: Mac, portIdx: z.number().int().min(1) }),
  z.object({ type: z.literal('wlan.toggle'), wlanId: Id, enabled: z.boolean() }),
  z.object({ type: z.literal('wol'), targetId: Id }),
  z.object({ type: z.literal('device.restart'), mac: Mac }),
  z.object({ type: z.literal('delay'), seconds: z.number().int().min(1).max(3600) }),
])

export const Rule = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  trigger: RuleTrigger,
  conditions: z.array(RuleCondition),
  actions: z.array(RuleAction).min(1),
  cooldownSeconds: z.number().int().min(0).max(86400),
  lastRunAt: Ts.nullable(),
  lastRunOk: z.boolean().nullable(),
  runCount: z.number().int(),
  createdAt: Ts,
})

export const RuleInput = Rule.pick({ name: true, description: true, enabled: true, trigger: true, conditions: true, actions: true, cooldownSeconds: true })

export const RuleRun = z.object({
  id: Id,
  ruleId: Id,
  ruleName: z.string(),
  ts: Ts,
  /** Snapshot of the triggering event payload. */
  event: z.record(z.string(), z.unknown()),
  test: z.boolean(),
  dryRun: z.boolean(),
  ok: z.boolean(),
  skipped: z.enum(['cooldown', 'conditions']).nullable(),
  results: z.array(z.object({ action: z.string(), ok: z.boolean(), message: z.string().nullable() })),
})

/* ───────────────────────────── PoE watchdog ───────────────────────────── */

export const WatchdogStatus = z.enum(['ok', 'failing', 'cycling', 'cooldown', 'limit', 'disabled', 'unknown'])

export const PoeWatchdog = z.object({
  id: Id,
  name: z.string(),
  targetMac: Mac.nullable(),
  targetIp: z.string(),
  method: z.enum(['icmp', 'tcp']),
  tcpPort: z.number().int().min(1).max(65535).nullable(),
  intervalSec: z.number().int().min(10).max(3600),
  failThreshold: z.number().int().min(1).max(60),
  cooldownMin: z.number().int().min(1).max(1440),
  maxCyclesPerDay: z.number().int().min(1).max(48),
  switchMac: Mac,
  switchName: z.string().nullable(),
  portIdx: z.number().int().min(1),
  enabled: z.boolean(),
  state: z.object({
    status: WatchdogStatus,
    consecutiveFails: z.number().int(),
    lastCheckAt: Ts.nullable(),
    lastOkAt: Ts.nullable(),
    lastCycleAt: Ts.nullable(),
    cyclesToday: z.number().int(),
    lastLatencyMs: z.number().nullable(),
  }),
})

export const PoeWatchdogInput = PoeWatchdog.omit({ id: true, state: true, switchName: true })

export const WatchdogEvent = z.object({
  id: Id,
  watchdogId: Id,
  ts: Ts,
  kind: z.enum(['fail', 'cycle', 'recovered', 'limit', 'error']),
  message: z.string(),
})

/** GET /api/watchdogs/ports — PoE-capable switch ports for the picker (uplinks excluded). */
export const PoePort = z.object({
  switchMac: Mac,
  switchName: z.string(),
  portIdx: z.number().int(),
  portName: z.string(),
  poe: z.boolean(),
  up: z.boolean(),
  powerW: z.number().nullable(),
  isUplink: z.boolean(),
  connectedClientMac: Mac.nullable(),
  connectedClientName: z.string().nullable(),
})

/* ───────────────────────────── Guest Wi-Fi ───────────────────────────── */

export const Wlan = z.object({ id: Id, name: z.string(), enabled: z.boolean(), security: z.string(), isGuest: z.boolean() })

export const GuestWifi = z.object({
  wlanId: Id.nullable(),
  ssid: z.string().nullable(),
  enabled: z.boolean(),
  rotation: z.object({
    cron: z.string(), // e.g. "0 4 * * 1" every Monday 04:00
    timezone: z.string(),
    style: z.enum(['words', 'digits', 'random']),
    length: z.number().int().min(8).max(63),
  }),
  /** Admin only — masked for others. */
  passphrase: z.string().nullable(),
  kioskToken: z.string().nullable(),
  kioskUrl: z.string().nullable(),
  lastRotatedAt: Ts.nullable(),
  nextRotationAt: Ts.nullable(),
})

export const GuestWifiInput = z.object({
  wlanId: Id.nullable(),
  enabled: z.boolean(),
  rotation: GuestWifi.shape.rotation,
})

/** GET /api/kiosk/:token (public, no auth). */
export const KioskPayload = z.object({
  ssid: z.string(),
  passphrase: z.string(),
  /** "WIFI:T:WPA;S:…;P:…;;" */
  wifiUri: z.string(),
  validUntil: Ts.nullable(),
  title: z.string(),
})

/* ───────────────────────────── Wake-on-LAN ───────────────────────────── */

export const WolTarget = z.object({
  id: Id,
  name: z.string(),
  mac: Mac,
  /** Broadcast address; null = derived from the client's network subnet. */
  broadcast: z.string().nullable(),
  effectiveBroadcast: z.string().nullable(),
  port: z.number().int().default(9),
  schedule: z.object({ cron: z.string(), timezone: z.string() }).nullable(),
  lastWokeAt: Ts.nullable(),
  online: z.boolean().nullable(),
})

export const WolTargetInput = WolTarget.pick({ name: true, mac: true, broadcast: true, port: true, schedule: true })

export type RuleTriggerT = z.infer<typeof RuleTrigger>
export type RuleConditionT = z.infer<typeof RuleCondition>
export type RuleActionT = z.infer<typeof RuleAction>
export type RuleT = z.infer<typeof Rule>
export type RuleInputT = z.infer<typeof RuleInput>
export type RuleRunT = z.infer<typeof RuleRun>
export type PoeWatchdogT = z.infer<typeof PoeWatchdog>
export type WatchdogEventT = z.infer<typeof WatchdogEvent>
export type PoePortT = z.infer<typeof PoePort>
export type WlanT = z.infer<typeof Wlan>
export type GuestWifiT = z.infer<typeof GuestWifi>
export type KioskPayloadT = z.infer<typeof KioskPayload>
export type WolTargetT = z.infer<typeof WolTarget>
