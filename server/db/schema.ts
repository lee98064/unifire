import { sql } from 'drizzle-orm'
import { blob, check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { LocaleT, RoleT } from '#shared/schemas/auth'
import type { CapabilityT, ControllerModeT, ControllerStatusT } from '#shared/schemas/controller'
import type { ApprovalStateT, BlockSourceT, ExtensionRequestT, QuotaT } from '#shared/schemas/access'
import type { EgressHealthT, EgressKindT, HealthStatusT } from '#shared/schemas/egress'
import type { GuestWifiT, PoeWatchdogT, RuleT, RuleRunT, WatchdogEventT, WolTargetT } from '#shared/schemas/automation'
import type { AuditEventT, SnapshotResourceT, SnapshotT } from '#shared/schemas/insight'
import type { FailoverPolicyT, ManagedRouteStateT, ManagedRouteT, RotationGeneratorT, ScheduleGridT, SwitchReasonT } from '#shared/schemas/routes'
import type { ChannelTypeT, NotificationEventT } from '#shared/schemas/system'

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar').notNull(),
  color: text('color').notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  pausedUntil: integer('paused_until'),
  pauseReason: text('pause_reason'),
  createdAt: integer('created_at').notNull(),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<RoleT>().notNull(),
  personId: text('person_id').references(() => people.id, { onDelete: 'set null' }),
  locale: text('locale').$type<LocaleT>().notNull().default('zh-TW'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
  authVersion: integer('auth_version').notNull().default(0),
}, t => [
  uniqueIndex('users_username_unique').on(sql`lower(${t.username})`),
  index('users_person').on(t.personId),
  index('users_role').on(t.role),
  check('users_valid_role', sql`${t.role} in ('admin', 'member')`),
])

export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
  transports: text('transports', { mode: 'json' }).$type<import('@simplewebauthn/server').AuthenticatorTransportFuture[]>(),
  aaguid: text('aaguid'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
}, t => [index('passkeys_user').on(t.userId)])

export const controller = sqliteTable('controller', {
  id: integer('id').primaryKey().default(1),
  url: text('url').notNull(),
  username: text('username').notNull(),
  encryptedPassword: text('encrypted_password').notNull(),
  site: text('site').notNull().default('default'),
  verifyMode: text('verify_mode').$type<NonNullable<ControllerStatusT['verifyMode']>>().notNull().default('fingerprint'),
  fingerprint: text('fingerprint'),
  caPem: text('ca_pem'),
  mode: text('mode').$type<ControllerModeT>().notNull().default('dry-run'),
  selfMac: text('self_mac'),
  selfIp: text('self_ip'),
  selfMacOverride: text('self_mac_override'),
  selfIpOverride: text('self_ip_override'),
  capabilities: text('capabilities', { mode: 'json' }).$type<CapabilityT[]>().notNull().default([]),
  networkVersion: text('network_version'),
  consoleVersion: text('console_version'),
  model: text('model'),
  timezone: text('timezone'),
  lastSyncAt: integer('last_sync_at'),
}, t => [check('controller_singleton', sql`${t.id} = 1`)])

export const egresses = sqliteTable('egresses', {
  // The primary key is the UniFi networkconf ID.
  id: text('id').primaryKey(),
  controllerId: integer('controller_id').notNull().default(1).references(() => controller.id),
  site: text('site').notNull().default('default'),
  name: text('name').notNull(),
  kind: text('kind').$type<EgressKindT>().notNull(),
  wanGroup: text('wan_group'),
  color: text('color').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  probeEnabled: integer('probe_enabled', { mode: 'boolean' }).notNull().default(false),
  probeIp: text('probe_ip'),
  probeRouteId: text('probe_route_id'),
  probeRouteScope: text('probe_route_scope'),
}, t => [index('egresses_controller_site').on(t.controllerId, t.site)])

export const egressSamples = sqliteTable('egress_samples', {
  egressId: text('egress_id').notNull().references(() => egresses.id, { onDelete: 'cascade' }),
  ts: integer('ts').notNull(),
  latencyMs: real('latency_ms'),
  lossPct: real('loss_pct'),
  jitterMs: real('jitter_ms'),
  source: text('source').$type<EgressHealthT['source']>().notNull().default('probe'),
  status: text('status').$type<HealthStatusT>().notNull(),
}, t => [primaryKey({ columns: [t.egressId, t.ts] }), index('egress_samples_ts').on(t.ts)])

export const egressHealth = sqliteTable('egress_health', {
  egressId: text('egress_id').primaryKey().references(() => egresses.id, { onDelete: 'cascade' }),
  value: text('value', { mode: 'json' }).$type<EgressHealthT>().notNull(),
  failedRounds: integer('failed_rounds').notNull(),
})

export const egressSampleRollups = sqliteTable('egress_sample_rollups', {
  egressId: text('egress_id').notNull().references(() => egresses.id, { onDelete: 'cascade' }),
  resolution: integer('resolution').notNull(),
  ts: integer('ts').notNull(),
  latencyTotal: real('latency_total').notNull(),
  latencyCount: integer('latency_count').notNull(),
  lossTotal: real('loss_total').notNull(),
  lossCount: integer('loss_count').notNull(),
  status: text('status').$type<HealthStatusT>().notNull(),
}, t => [primaryKey({ columns: [t.egressId, t.resolution, t.ts] })])

export const egressHealthTransitions = sqliteTable('egress_health_transitions', {
  egressId: text('egress_id').notNull().references(() => egresses.id, { onDelete: 'cascade' }),
  ts: integer('ts').notNull(),
  status: text('status').$type<HealthStatusT>().notNull(),
}, t => [primaryKey({ columns: [t.egressId, t.ts] })])

export const egressIpChecks = sqliteTable('egress_ip_checks', {
  egressId: text('egress_id').notNull().references(() => egresses.id, { onDelete: 'cascade' }),
  ts: integer('ts').notNull(),
  ip: text('ip'),
  country: text('country'),
  colo: text('colo'),
  latencyMs: real('latency_ms'),
  changed: integer('changed', { mode: 'boolean' }).notNull().default(false),
  error: text('error'),
}, t => [primaryKey({ columns: [t.egressId, t.ts] }), index('egress_ip_checks_ts').on(t.ts)])

export const managedRoutes = sqliteTable('managed_routes', {
  id: text('id').primaryKey(),
  controllerId: integer('controller_id').notNull().default(1).references(() => controller.id),
  site: text('site').notNull().default('default'),
  unifiRouteId: text('unifi_route_id').notNull(),
  name: text('name').notNull(),
  controllerScope: text('controller_scope'),
  baselineFingerprint: text('baseline_fingerprint').notNull(),
  routeShape: text('route_shape', { mode: 'json' }).$type<Pick<ManagedRouteT, 'targets' | 'matchingTarget' | 'destinations' | 'killSwitch'>>(),
  failoverPrimary: text('failover_primary'),
  failoverEgress: text('failover_egress'),
  failoverRecoverSince: integer('failover_recover_since'),
  defaultEgressId: text('default_egress_id').notNull(),
  failover: text('failover', { mode: 'json' }).$type<FailoverPolicyT>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  state: text('state').$type<ManagedRouteStateT>().notNull().default('pending'),
  stateDetail: text('state_detail'),
  createdByUnifire: integer('created_by_unifire', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  lastSwitchAt: integer('last_switch_at'),
}, t => [uniqueIndex('managed_routes_controller_route').on(t.controllerId, t.site, t.unifiRouteId)])

export const routeSchedules = sqliteTable('route_schedules', {
  managedRouteId: text('managed_route_id').primaryKey().references(() => managedRoutes.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull(),
  grid: text('grid', { mode: 'json' }).$type<ScheduleGridT>().notNull(),
  generator: text('generator', { mode: 'json' }).$type<RotationGeneratorT>(),
})

export const routeOverrides = sqliteTable('route_overrides', {
  id: text('id').primaryKey(),
  managedRouteId: text('managed_route_id').notNull().references(() => managedRoutes.id, { onDelete: 'cascade' }),
  egressId: text('egress_id').notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  reason: text('reason'),
  createdBy: text('created_by').notNull(),
}, t => [index('route_overrides_route_end').on(t.managedRouteId, t.endsAt), index('route_overrides_end').on(t.endsAt)])

export const routeSwitchLog = sqliteTable('route_switch_log', {
  id: text('id').primaryKey(),
  ts: integer('ts').notNull(),
  managedRouteId: text('managed_route_id').notNull(),
  routeName: text('route_name').notNull(),
  fromEgressId: text('from_egress_id'),
  toEgressId: text('to_egress_id').notNull(),
  reason: text('reason').$type<SwitchReasonT>().notNull(),
  verified: integer('verified', { mode: 'boolean' }).notNull(),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
  durationMs: integer('duration_ms'),
  error: text('error'),
}, t => [index('route_switch_log_route_ts').on(t.managedRouteId, t.ts), index('route_switch_log_ts').on(t.ts)])

export const routeObservations = sqliteTable('route_observations', {
  scope: text('scope').notNull(),
  routeId: text('route_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  egressId: text('egress_id'),
}, t => [primaryKey({ columns: [t.scope, t.routeId] })])

export const routeExternalChanges = sqliteTable('route_external_changes', {
  scope: text('scope').notNull(),
  routeId: text('route_id').notNull(),
  ts: integer('ts').notNull(),
  egressChanged: integer('egress_changed', { mode: 'boolean' }).notNull(),
}, t => [primaryKey({ columns: [t.scope, t.routeId, t.ts] }), index('route_external_changes_ts').on(t.ts)])

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
})

export const personGroups = sqliteTable('person_groups', {
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
}, t => [primaryKey({ columns: [t.personId, t.groupId] }), index('person_groups_group').on(t.groupId)])

export const clients = sqliteTable('clients', {
  mac: text('mac').primaryKey(),
  alias: text('alias'),
  note: text('note'),
  hostname: text('hostname'),
  vendor: text('vendor'),
  randomizedMac: integer('randomized_mac', { mode: 'boolean' }).notNull().default(false),
  approval: text('approval').$type<ApprovalStateT>().notNull().default('pending'),
  firstSeen: integer('first_seen'),
  lastSeen: integer('last_seen'),
  detectedAt: integer('detected_at'),
}, t => [index('clients_last_seen').on(t.lastSeen), index('clients_approval_detected').on(t.approval, t.detectedAt)])

export const personDevices = sqliteTable('person_devices', {
  mac: text('mac').primaryKey().references(() => clients.mac, { onDelete: 'cascade' }),
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  presence: integer('presence', { mode: 'boolean' }).notNull().default(false),
}, t => [index('person_devices_person').on(t.personId)])

export const blocks = sqliteTable('blocks', {
  id: text('id').primaryKey(),
  mac: text('mac').notNull().references(() => clients.mac, { onDelete: 'cascade' }),
  source: text('source').$type<BlockSourceT>().notNull(),
  refId: text('ref_id'),
  label: text('label').notNull(),
  until: integer('until'),
  applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
}, t => [
  uniqueIndex('blocks_mac_source_ref').on(t.mac, t.source, sql`coalesce(${t.refId}, '')`),
  index('blocks_until').on(t.until),
])

export const pauseSchedules = sqliteTable('pause_schedules', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  days: text('days', { mode: 'json' }).$type<number[]>().notNull(),
  start: text('start').notNull(),
  end: text('end').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, t => [index('pause_schedules_person').on(t.personId)])

export const allowances = sqliteTable('allowances', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  startsAt: integer('starts_at').notNull(),
  until: integer('until').notNull(),
}, t => [index('allowances_person_until').on(t.personId, t.until), index('allowances_until').on(t.until)])

export const quotas = sqliteTable('quotas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scopeType: text('scope_type').$type<QuotaT['scope']['type']>().notNull(),
  scopeId: text('scope_id').notNull(),
  metric: text('metric').$type<QuotaT['metric']>().notNull(),
  period: text('period').$type<QuotaT['period']>().notNull(),
  limit: real('limit').notNull(),
  weekdayLimits: text('weekday_limits', { mode: 'json' }).$type<NonNullable<QuotaT['weekdayLimits']>>(),
  warnAtPct: real('warn_at_pct').notNull().default(80),
  action: text('action', { mode: 'json' }).$type<QuotaT['action']>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, t => [index('quotas_scope').on(t.scopeType, t.scopeId)])

function usageColumns() {
  return {
    mac: text('mac').notNull(),
    ts: integer('ts').notNull(),
    rxBytes: integer('rx_bytes').notNull(),
    txBytes: integer('tx_bytes').notNull(),
  }
}

export const usageMinutes = sqliteTable('usage_minutes', {
  ...usageColumns(),
  active: integer('active', { mode: 'boolean' }).notNull(),
}, t => [primaryKey({ columns: [t.mac, t.ts] }), index('usage_minutes_ts').on(t.ts)])

export const usageHourly = sqliteTable('usage_hourly', {
  ...usageColumns(),
  activeMinutes: integer('active_minutes').notNull(),
}, t => [primaryKey({ columns: [t.mac, t.ts] }), index('usage_hourly_ts').on(t.ts)])

export const usageDaily = sqliteTable('usage_daily', {
  ...usageColumns(),
  activeMinutes: integer('active_minutes').notNull(),
}, t => [primaryKey({ columns: [t.mac, t.ts] }), index('usage_daily_ts').on(t.ts)])

export const extensionRequests = sqliteTable('extension_requests', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  quotaId: text('quota_id').references(() => quotas.id, { onDelete: 'set null' }),
  amount: real('amount').notNull(),
  grantedAmount: real('granted_amount'),
  reason: text('reason'),
  status: text('status').$type<ExtensionRequestT['status']>().notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
  decidedBy: text('decided_by'),
}, t => [
  index('extension_requests_person_ts').on(t.personId, t.createdAt),
  index('extension_requests_status_ts').on(t.status, t.createdAt),
  index('extension_requests_quota').on(t.quotaId),
])

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  trigger: text('trigger', { mode: 'json' }).$type<RuleT['trigger']>().notNull(),
  conditions: text('conditions', { mode: 'json' }).$type<RuleT['conditions']>().notNull(),
  actions: text('actions', { mode: 'json' }).$type<RuleT['actions']>().notNull(),
  cooldownSeconds: integer('cooldown_seconds').notNull(),
  lastRunAt: integer('last_run_at'),
  lastRunOk: integer('last_run_ok', { mode: 'boolean' }),
  runCount: integer('run_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

export const ruleRuns = sqliteTable('rule_runs', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull(),
  ruleName: text('rule_name').notNull(),
  ts: integer('ts').notNull(),
  event: text('event', { mode: 'json' }).$type<RuleRunT['event']>().notNull(),
  test: integer('test', { mode: 'boolean' }).notNull(),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  skipped: text('skipped').$type<NonNullable<RuleRunT['skipped']>>(),
  results: text('results', { mode: 'json' }).$type<RuleRunT['results']>().notNull(),
}, t => [index('rule_runs_rule_ts').on(t.ruleId, t.ts), index('rule_runs_ts').on(t.ts)])

export const poeWatchdogs = sqliteTable('poe_watchdogs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  targetMac: text('target_mac'),
  targetIp: text('target_ip').notNull(),
  method: text('method').$type<PoeWatchdogT['method']>().notNull(),
  tcpPort: integer('tcp_port'),
  intervalSec: integer('interval_sec').notNull(),
  failThreshold: integer('fail_threshold').notNull(),
  cooldownMin: integer('cooldown_min').notNull(),
  maxCyclesPerDay: integer('max_cycles_per_day').notNull(),
  switchMac: text('switch_mac').notNull(),
  switchName: text('switch_name'),
  portIdx: integer('port_idx').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  state: text('state', { mode: 'json' }).$type<PoeWatchdogT['state']>().notNull(),
}, t => [uniqueIndex('poe_watchdogs_switch_port').on(t.switchMac, t.portIdx)])

export const watchdogEvents = sqliteTable('watchdog_events', {
  id: text('id').primaryKey(),
  watchdogId: text('watchdog_id').notNull(),
  ts: integer('ts').notNull(),
  kind: text('kind').$type<WatchdogEventT['kind']>().notNull(),
  message: text('message').notNull(),
}, t => [index('watchdog_events_watchdog_ts').on(t.watchdogId, t.ts), index('watchdog_events_ts').on(t.ts)])

export const guestWifi = sqliteTable('guest_wifi', {
  id: integer('id').primaryKey().default(1),
  wlanId: text('wlan_id'),
  ssid: text('ssid'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  rotation: text('rotation', { mode: 'json' }).$type<GuestWifiT['rotation']>().notNull(),
  encryptedPassphrase: text('encrypted_passphrase'),
  encryptedKioskToken: text('encrypted_kiosk_token'),
  kioskTokenHash: text('kiosk_token_hash').unique(),
  lastRotatedAt: integer('last_rotated_at'),
  nextRotationAt: integer('next_rotation_at'),
}, t => [check('guest_wifi_singleton', sql`${t.id} = 1`)])

export const wolTargets = sqliteTable('wol_targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mac: text('mac').notNull(),
  broadcast: text('broadcast'),
  port: integer('port').notNull().default(9),
  schedule: text('schedule', { mode: 'json' }).$type<NonNullable<WolTargetT['schedule']>>(),
  lastWokeAt: integer('last_woke_at'),
}, t => [index('wol_targets_mac').on(t.mac)])

export const snapshots = sqliteTable('snapshots', {
  id: text('id').primaryKey(),
  ts: integer('ts').notNull(),
  trigger: text('trigger').$type<SnapshotT['trigger']>().notNull(),
  note: text('note'),
  networkVersion: text('network_version'),
  complete: integer('complete', { mode: 'boolean' }).notNull(),
  failed: text('failed', { mode: 'json' }).$type<SnapshotResourceT[]>().notNull(),
  counts: text('counts', { mode: 'json' }).$type<SnapshotT['counts']>().notNull(),
  changeCount: integer('change_count'),
  sizeBytes: integer('size_bytes').notNull(),
}, t => [index('snapshots_ts_id').on(t.ts, t.id)])

export const snapshotItems = sqliteTable('snapshot_items', {
  snapshotId: text('snapshot_id').notNull().references(() => snapshots.id, { onDelete: 'cascade' }),
  resource: text('resource').$type<SnapshotResourceT>().notNull(),
  itemId: text('item_id').notNull(),
  encryptedDoc: text('encrypted_doc').notNull(),
  hash: text('hash').notNull(),
  label: text('label').notNull(),
}, t => [primaryKey({ columns: [t.snapshotId, t.resource, t.itemId] })])

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  ts: integer('ts').notNull(),
  actorType: text('actor_type').$type<AuditEventT['actor']['type']>().notNull(),
  actorId: text('actor_id'),
  actorName: text('actor_name'),
  category: text('category').$type<AuditEventT['category']>().notNull(),
  action: text('action').notNull(),
  severity: text('severity').$type<AuditEventT['severity']>().notNull(),
  target: text('target', { mode: 'json' }).$type<NonNullable<AuditEventT['target']>>(),
  messageKey: text('message_key').notNull(),
  messageParams: text('message_params', { mode: 'json' }).$type<AuditEventT['messageParams']>().notNull(),
  diff: text('diff', { mode: 'json' }).$type<NonNullable<AuditEventT['diff']>>(),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
}, t => [
  index('audit_events_ts_id').on(t.ts, t.id),
  index('audit_events_category_ts').on(t.category, t.ts, t.id),
  index('audit_events_actor_ts').on(t.actorType, t.ts, t.id),
])

export const presenceSessions = sqliteTable('presence_sessions', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  mac: text('mac').notNull(),
  start: integer('start').notNull(),
  end: integer('end'),
}, t => [
  index('presence_sessions_person_start').on(t.personId, t.start),
  index('presence_sessions_start').on(t.start),
  index('presence_sessions_mac').on(t.mac),
])

export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').$type<ChannelTypeT>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  encryptedConfig: text('encrypted_config').notNull(),
  events: text('events', { mode: 'json' }).$type<NotificationEventT[]>().notNull(),
  lastSentAt: integer('last_sent_at'),
  lastError: text('last_error'),
})

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  encryptedKeys: text('encrypted_keys').notNull(),
  deviceLabel: text('device_label'),
  createdAt: integer('created_at').notNull(),
}, t => [index('push_subscriptions_user').on(t.userId)])

export const pushActionTokens = sqliteTable('push_action_tokens', {
  tokenHash: blob('token_hash', { mode: 'buffer' }).primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
}, t => [index('push_action_tokens_expiry').on(t.expiresAt), index('push_action_tokens_user').on(t.userId)])

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
})

export const leases = sqliteTable('leases', {
  name: text('name').primaryKey(),
  owner: text('owner').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

export const speedtests = sqliteTable('speedtests', {
  id: text('id').primaryKey(),
  ts: integer('ts').notNull(),
  egressId: text('egress_id'),
  downMbps: real('down_mbps').notNull(),
  upMbps: real('up_mbps').notNull(),
  latencyMs: real('latency_ms'),
}, t => [index('speedtests_ts').on(t.ts), index('speedtests_egress_ts').on(t.egressId, t.ts)])
