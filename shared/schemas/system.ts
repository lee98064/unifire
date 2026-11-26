import { z } from 'zod'
import { Id, Mac, Ts } from './common'
import { Incident, IncidentSeverity } from './infra'
import { HealthStatus } from './egress'
import { AuditEvent } from './insight'
import { SwitchReason, SwitchLogEntry } from './routes'

/* ───────────────────────────── Notifications ───────────────────────────── */

export const NotificationEvent = z.enum([
  'new_device',
  'route_switch',
  'route_drift',
  'egress_down',
  'egress_up',
  'egress_ip_changed',
  'quota_warning',
  'quota_exceeded',
  'extension_request',
  'poe_cycle',
  'external_change',
  'guest_wifi_rotated',
  'controller_error',
  'rule',
  /* phase 2 */
  'device_firmware',
  'port_issue',
  'poe_schedule',
  'incident_opened',
  'incident_resolved',
])

export const ChannelType = z.enum(['webpush', 'telegram', 'discord', 'webhook', 'ntfy'])

/** Secrets (bot token, webhook URL, ntfy token) are write-only: returned masked ("••••1234"). */
export const ChannelConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webpush') }),
  z.object({ type: z.literal('telegram'), botToken: z.string(), chatId: z.string(), interactive: z.boolean().default(true) }),
  z.object({ type: z.literal('discord'), webhookUrl: z.string() }),
  z.object({ type: z.literal('webhook'), url: z.string(), method: z.enum(['POST', 'PUT']).default('POST'), secret: z.string().nullable().default(null) }),
  z.object({ type: z.literal('ntfy'), server: z.string().default('https://ntfy.sh'), topic: z.string(), token: z.string().nullable().default(null) }),
])

export const NotificationChannel = z.object({
  id: Id,
  name: z.string(),
  enabled: z.boolean(),
  config: ChannelConfig,
  events: z.array(NotificationEvent),
  lastSentAt: Ts.nullable(),
  lastError: z.string().nullable(),
})

export const NotificationChannelInput = NotificationChannel.pick({ name: true, enabled: true, config: true, events: true })

export const PushSubscriptionInput = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  deviceLabel: z.string().max(80).optional(),
})

/** Data attached to Web Push payloads; SW uses `actions` to call back the API. */
export const PushPayload = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string().optional(),
  url: z.string().default('/'),
  event: NotificationEvent,
  badgeCount: z.number().int().optional(),
  actions: z.array(z.object({
    action: z.string(), // e.g. "approve", "block", "extend"
    title: z.string(),
    /** Signed one-time action URL handled by POST /api/push/action. */
    endpoint: z.string(),
  })).default([]),
})

/* ───────────────────────────── Settings ───────────────────────────── */

export const Settings = z.object({
  timezone: z.string(),
  siteUrl: z.string().nullable(), // public URL behind reverse proxy (for push links / kiosk)
  probe: z.object({
    intervalSec: z.number().int().min(10).max(600),
    /** Destination IPs assigned 1:1 to egresses for health probes. */
    ipPool: z.array(z.string()),
    sweepIntervalMin: z.number().int().min(0).max(1440), // 0 = manual only
    method: z.enum(['tcp', 'dns', 'icmp']),
    failThreshold: z.number().int().min(1).max(20),
  }),
  approval: z.object({
    mode: z.enum(['off', 'notify', 'strict']),
    /** Treat locally-administered (randomized) MACs as known after first approval of the same hostname. */
    matchRandomizedByHostname: z.boolean(),
  }),
  presence: z.object({ graceMinutes: z.number().int().min(1).max(120) }),
  usage: z.object({
    /** Bytes in a minute above which the minute counts as "active". */
    activeThresholdBytes: z.number().int().min(1),
    retainRawDays: z.number().int().min(1).max(90),
  }),
  snapshots: z.object({ cron: z.string(), retainDays: z.number().int().min(1).max(3650), preWrite: z.boolean() }),
  /** Network id → broadcast override for Wake-on-LAN. */
  broadcastOverrides: z.record(z.string(), z.string()),
  selfMacOverride: Mac.nullable(),
  /** UniFi route ids Unifire must never write. */
  excludedRouteIds: z.array(Id),
  /* ── phase 2 (docs/PLAN-infra.md) ── */
  infra: z.object({
    tempWarnC: z.number().min(30).max(120),
    cpuWarnPct: z.number().min(10).max(100),
    memWarnPct: z.number().min(10).max(100),
    /** RX+TX errors as % of packets over an hour that counts as a port issue. */
    errorRatePct: z.number().min(0.001).max(100),
    flapsPerHour: z.number().int().min(2).max(100),
    /** Consecutive polls below baseline before a downgrade is reported. */
    downgradeMinPolls: z.number().int().min(1).max(30),
    /** Ports whose issues are ignored (e.g. a device that only does 100M). */
    ignoredPorts: z.array(z.object({ switchMac: Mac, portIdx: z.number().int().min(1) })),
    retainRawDays: z.number().int().min(1).max(90),
    retainRollupDays: z.number().int().min(30).max(3650),
  }),
  energy: z.object({
    /** Price per kWh; null = don't show cost. */
    ratePerKwh: z.number().min(0).nullable(),
    currency: z.string().min(1).max(8),
  }),
  rooms: z.object({
    /** Minutes on a new AP before the person's room changes. */
    dwellMinutes: z.number().int().min(1).max(30),
  }),
  sticky: z.object({
    enabled: z.boolean(),
    signalDbm: z.number().int().min(-95).max(-50),
    minutes: z.number().int().min(1).max(120),
    /** Automatically kick sticky clients so they re-associate. */
    nudge: z.boolean(),
    maxNudgesPerDay: z.number().int().min(1).max(20),
    /** Never nudge while the client moves more than this (bps), e.g. during a video call. */
    skipAboveBps: z.number().int().min(0),
  }),
  incidents: z.object({
    windowMinutes: z.number().int().min(1).max(60),
    quietMinutes: z.number().int().min(1).max(60),
    notifyMinSeverity: z.union([IncidentSeverity, z.literal('off')]),
    massDisconnectMin: z.number().int().min(2).max(100),
    massDisconnectPct: z.number().min(5).max(100),
  }),
})

export const SettingsInput = Settings.partial()

/* ───────────────────────────── Dashboard ───────────────────────────── */

export const UpcomingSwitch = z.object({
  at: Ts,
  managedRouteId: Id,
  routeName: z.string(),
  fromEgressId: Id.nullable(),
  toEgressId: Id,
  reason: SwitchReason,
})

/** GET /api/dashboard */
export const DashboardSummary = z.object({
  generatedAt: Ts,
  wans: z.array(z.object({ egressId: Id, name: z.string(), status: HealthStatus, latencyMs: z.number().nullable(), publicIp: z.string().nullable(), rxBps: z.number().nullable(), txBps: z.number().nullable() })),
  egresses: z.object({ healthy: z.number(), degraded: z.number(), down: z.number(), unknown: z.number() }),
  clients: z.object({ online: z.number(), known: z.number(), pendingApproval: z.number(), blocked: z.number() }),
  people: z.object({ home: z.number(), total: z.number(), paused: z.number() }),
  routes: z.object({ managed: z.number(), drift: z.number(), overrides: z.number(), unifiTotal: z.number() }),
  upcoming: z.array(UpcomingSwitch),
  recentSwitches: z.array(SwitchLogEntry),
  recentAudit: z.array(AuditEvent),
  /** Traffic sparkline for the gateway (last 60 min, 1-min buckets). */
  throughput: z.array(z.object({ ts: Ts, rxBps: z.number(), txBps: z.number() })),
  /** Phase 2: infrastructure health strip. */
  infra: z.object({
    total: z.number().int(),
    online: z.number().int(),
    offline: z.number().int(),
    /** Devices with at least one warning/error issue. */
    withIssues: z.number().int(),
    /** Unacknowledged port events. */
    portEvents: z.number().int(),
    poeWatts: z.number().nullable(),
    openIncidents: z.number().int(),
  }),
  /** Open incidents (most severe first, max 3) for the dashboard banner. WP11; [] before. */
  incidents: z.array(Incident),
})

/* ───────────────────────────── Live events (SSE) ───────────────────────────── */

/**
 * GET /api/events — text/event-stream. Each message: `event: <type>` + JSON `data`.
 * The UI uses these to invalidate/refresh caches; payloads are small.
 */
export const LiveEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), data: z.object({ ts: Ts }) }),
  z.object({ type: z.literal('controller'), data: z.object({ connected: z.boolean(), wsConnected: z.boolean(), lastError: z.string().nullable() }) }),
  z.object({ type: z.literal('egress.health'), data: z.array(z.object({ egressId: Id, status: HealthStatus, latencyMs: z.number().nullable(), lossPct: z.number().nullable() })) }),
  z.object({ type: z.literal('route.switched'), data: SwitchLogEntry }),
  z.object({ type: z.literal('route.changed'), data: z.object({ managedRouteId: Id }) }),
  z.object({ type: z.literal('client.changed'), data: z.object({ macs: z.array(Mac) }) }),
  z.object({ type: z.literal('approval.new'), data: z.object({ mac: Mac, displayName: z.string() }) }),
  z.object({ type: z.literal('presence'), data: z.object({ personId: Id, home: z.boolean() }) }),
  z.object({ type: z.literal('quota'), data: z.object({ personId: Id.nullable(), quotaId: Id, state: z.enum(['ok', 'warning', 'exceeded']) }) }),
  z.object({ type: z.literal('extension.request'), data: z.object({ requestId: Id, personId: Id }) }),
  z.object({ type: z.literal('audit'), data: AuditEvent }),
  z.object({ type: z.literal('sweep'), data: z.object({ running: z.boolean(), done: z.number(), total: z.number() }) }),
  z.object({ type: z.literal('toast'), data: z.object({ level: z.enum(['info', 'success', 'warning', 'error']), titleKey: z.string(), params: z.record(z.string(), z.string()) }) }),
  /* phase 2 */
  z.object({ type: z.literal('device'), data: z.object({ macs: z.array(Mac) }) }),
  z.object({ type: z.literal('port.event'), data: z.object({ id: Id, switchMac: Mac, portIdx: z.number().int(), kind: z.string() }) }),
  z.object({ type: z.literal('poe'), data: z.object({ switchMac: Mac, portIdx: z.number().int() }) }),
  z.object({ type: z.literal('topology'), data: z.object({ ts: Ts }) }),
  z.object({ type: z.literal('room'), data: z.object({ personId: Id, roomId: Id.nullable() }) }),
  z.object({ type: z.literal('incident'), data: z.object({ id: Id, status: z.enum(['open', 'resolved']), severity: IncidentSeverity }) }),
])

export type NotificationEventT = z.infer<typeof NotificationEvent>
export type ChannelTypeT = z.infer<typeof ChannelType>
export type ChannelConfigT = z.infer<typeof ChannelConfig>
export type NotificationChannelT = z.infer<typeof NotificationChannel>
export type PushPayloadT = z.infer<typeof PushPayload>
export type SettingsT = z.infer<typeof Settings>
export type DashboardSummaryT = z.infer<typeof DashboardSummary>
export type UpcomingSwitchT = z.infer<typeof UpcomingSwitch>
export type LiveEventT = z.infer<typeof LiveEvent>
