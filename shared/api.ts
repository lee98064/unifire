/**
 * Unifire HTTP API contract — the single source of truth shared by UI (app/) and Nitro (server/api).
 *
 * Conventions
 * - All paths are under /api. JSON in/out. Timestamps = epoch ms.
 * - `auth`: 'public' | 'any' (logged-in) | 'admin' | 'member' (member-or-admin, scoped to own person).
 * - Inputs are validated with the referenced zod schema (body for POST/PUT/PATCH, query for GET).
 * - Errors: createError({ statusCode, message, data: { code } }) → body matches ApiError.
 * - Any write that reaches UniFi honours dry-run mode: it is logged + audited with dryRun=true and returns
 *   normally, but nothing is sent to the controller.
 * - Handlers live at server/api/<path>.<method>.ts following Nitro file routing.
 */
import { z } from 'zod'
import * as A from './schemas/auth'
import * as C from './schemas/controller'
import * as E from './schemas/egress'
import * as R from './schemas/routes'
import * as X from './schemas/access'
import * as M from './schemas/automation'
import * as I from './schemas/insight'
import * as S from './schemas/system'
import { Ok, Paged } from './schemas/common'

type Auth = 'public' | 'any' | 'admin' | 'member'
interface Endpoint { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; auth: Auth; input?: z.ZodTypeAny; output: z.ZodTypeAny; note?: string }

const ep = (method: Endpoint['method'], path: string, auth: Auth, output: z.ZodTypeAny, input?: z.ZodTypeAny, note?: string): Endpoint => ({ method, path, auth, output, input, note })

export const api = {
  // ── ops ───────────────────────────────────────────────────────
  health: ep('GET', '/api/health', 'public', z.object({ ok: z.boolean(), version: z.string(), uptimeSec: z.number(), db: z.string(), controller: z.enum(['connected', 'disconnected', 'unconfigured']) })),

  // ── setup & auth ──────────────────────────────────────────────
  setupStatus: ep('GET', '/api/setup/status', 'public', A.SetupStatus),
  setupAdmin: ep('POST', '/api/setup/admin', 'public', A.User, A.UserCreateInput.omit({ role: true, personId: true }), 'Only while no admin exists; logs the new admin in.'),
  setupInspect: ep('POST', '/api/setup/controller/inspect', 'admin', C.CertificateInfo, z.object({ url: z.string().url() }), 'Fetch TLS certificate for TOFU confirmation.'),
  setupTest: ep('POST', '/api/setup/controller/test', 'admin', C.ControllerStatus, C.ControllerInput, 'Login + capability probe without saving.'),
  login: ep('POST', '/api/auth/login', 'public', A.User, A.LoginInput),
  logout: ep('POST', '/api/auth/logout', 'any', Ok),
  me: ep('GET', '/api/auth/me', 'any', A.User),
  changePassword: ep('POST', '/api/auth/password', 'any', Ok, A.PasswordChangeInput),
  // Passkeys use nuxt-auth-utils defineWebAuthnRegisterEventHandler / defineWebAuthnAuthenticateEventHandler:
  //   /api/auth/webauthn/register (any)  /api/auth/webauthn/authenticate (public)
  users: ep('GET', '/api/users', 'admin', z.array(A.User)),
  userCreate: ep('POST', '/api/users', 'admin', A.User, A.UserCreateInput),
  userUpdate: ep('PATCH', '/api/users/:id', 'admin', A.User, A.UserUpdateInput),
  userDelete: ep('DELETE', '/api/users/:id', 'admin', Ok),

  // ── controller ────────────────────────────────────────────────
  controller: ep('GET', '/api/controller', 'admin', C.ControllerStatus),
  controllerSave: ep('PUT', '/api/controller', 'admin', C.ControllerStatus, C.ControllerInput),
  controllerProbe: ep('POST', '/api/controller/probe', 'admin', C.ControllerStatus, undefined, 'Re-run capability matrix (write checks use a disabled scratch route).'),
  controllerMode: ep('PUT', '/api/controller/mode', 'admin', C.ControllerStatus, C.ModeInput, 'dry-run ↔ live'),
  controllerSync: ep('POST', '/api/controller/sync', 'admin', Ok, undefined, 'Force refresh caches.'),

  // ── dashboard & live ──────────────────────────────────────────
  dashboard: ep('GET', '/api/dashboard', 'admin', S.DashboardSummary),
  events: ep('GET', '/api/events', 'any', S.LiveEvent, undefined, 'SSE stream; members only receive events about their own person.'),

  // ── egresses & probes ─────────────────────────────────────────
  egresses: ep('GET', '/api/egresses', 'admin', z.array(E.Egress)),
  egressUpdate: ep('PATCH', '/api/egresses/:id', 'admin', E.Egress, E.EgressUpdateInput),
  egressHistory: ep('GET', '/api/egresses/:id/history', 'admin', E.EgressHistory, z.object({ range: E.EgressHistory.shape.range.default('24h') })),
  sweepStatus: ep('GET', '/api/egresses/sweep', 'admin', E.SweepStatus),
  sweepStart: ep('POST', '/api/egresses/sweep', 'admin', E.SweepStatus, z.object({ egressIds: z.array(z.string()).optional() })),
  probes: ep('GET', '/api/probes', 'admin', E.ProbeOverview),
  probesProvision: ep('POST', '/api/probes/provision', 'admin', E.ProbeOverview, undefined, 'Create/repair [unifire-probe] routes for all probe-enabled egresses.'),
  probesCleanup: ep('DELETE', '/api/probes', 'admin', E.ProbeOverview, undefined, 'Delete all [unifire-probe] routes.'),

  // ── routes ────────────────────────────────────────────────────
  unifiRoutes: ep('GET', '/api/routes', 'admin', z.array(R.UnifiRoute)),
  managedRoutes: ep('GET', '/api/managed-routes', 'admin', z.array(R.ManagedRoute)),
  managedRoute: ep('GET', '/api/managed-routes/:id', 'admin', R.ManagedRoute),
  managedRouteCreate: ep('POST', '/api/managed-routes', 'admin', R.ManagedRoute, R.ManagedRouteCreateInput),
  managedRouteUpdate: ep('PATCH', '/api/managed-routes/:id', 'admin', R.ManagedRoute, R.ManagedRouteUpdateInput),
  managedRouteRelease: ep('DELETE', '/api/managed-routes/:id', 'admin', Ok, z.object({ deleteFromUnifi: z.coerce.boolean().default(false) }), 'Stop managing; optionally delete the UniFi route if Unifire created it.'),
  managedRouteSchedule: ep('PUT', '/api/managed-routes/:id/schedule', 'admin', R.ManagedRoute, R.ScheduleInput),
  managedRouteOverride: ep('POST', '/api/managed-routes/:id/override', 'admin', R.ManagedRoute, R.OverrideInput),
  managedRouteOverrideClear: ep('DELETE', '/api/managed-routes/:id/override', 'admin', R.ManagedRoute),
  managedRouteResume: ep('POST', '/api/managed-routes/:id/resume', 'admin', R.ManagedRoute, undefined, 'Accept current UniFi doc as new baseline after drift and resume.'),
  managedRoutePreview: ep('GET', '/api/managed-routes/:id/preview', 'admin', R.RoutePreview, z.object({ hours: z.coerce.number().int().min(1).max(336).default(48) })),
  switchLog: ep('GET', '/api/switch-log', 'admin', Paged(R.SwitchLogEntry), z.object({ managedRouteId: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().default(50) })),

  // ── clients & approvals ───────────────────────────────────────
  clients: ep('GET', '/api/clients', 'admin', z.array(X.Client), z.object({ online: z.coerce.boolean().optional(), personId: z.string().optional(), q: z.string().optional() })),
  client: ep('GET', '/api/clients/:mac', 'admin', X.Client),
  clientUpdate: ep('PATCH', '/api/clients/:mac', 'admin', X.Client, X.ClientUpdateInput),
  clientAction: ep('POST', '/api/clients/:mac/action', 'admin', X.Client, X.ClientActionInput),
  clientUsage: ep('GET', '/api/clients/:mac/usage', 'admin', X.ClientUsage, z.object({ range: X.ClientUsage.shape.range.default('24h') })),
  approvals: ep('GET', '/api/approvals', 'admin', z.array(X.ApprovalItem)),
  approvalDecide: ep('POST', '/api/approvals/:mac', 'admin', X.Client, X.ApprovalDecisionInput),

  // ── people, groups, quotas ────────────────────────────────────
  people: ep('GET', '/api/people', 'admin', z.array(X.Person)),
  personCreate: ep('POST', '/api/people', 'admin', X.Person, X.PersonInput),
  personUpdate: ep('PATCH', '/api/people/:id', 'admin', X.Person, X.PersonInput.partial()),
  personDelete: ep('DELETE', '/api/people/:id', 'admin', Ok),
  personPause: ep('POST', '/api/people/:id/pause', 'admin', X.Person, X.PauseInput),
  personResume: ep('POST', '/api/people/:id/resume', 'admin', X.Person),
  personAllow: ep('POST', '/api/people/:id/allow', 'admin', X.Person, X.AllowanceInput),
  personQuotas: ep('GET', '/api/people/:id/quotas', 'admin', z.array(X.QuotaStatus)),
  groups: ep('GET', '/api/groups', 'admin', z.array(X.Group)),
  groupCreate: ep('POST', '/api/groups', 'admin', X.Group, X.GroupInput),
  groupUpdate: ep('PATCH', '/api/groups/:id', 'admin', X.Group, X.GroupInput.partial()),
  groupDelete: ep('DELETE', '/api/groups/:id', 'admin', Ok),
  groupPause: ep('POST', '/api/groups/:id/pause', 'admin', z.array(X.Person), X.PauseInput),
  groupResume: ep('POST', '/api/groups/:id/resume', 'admin', z.array(X.Person)),
  quotas: ep('GET', '/api/quotas', 'admin', z.array(X.Quota.extend({ statuses: z.array(X.QuotaStatus.extend({ personId: z.string().nullable() })) }))),
  quotaCreate: ep('POST', '/api/quotas', 'admin', X.Quota, X.QuotaInput),
  quotaUpdate: ep('PATCH', '/api/quotas/:id', 'admin', X.Quota, X.QuotaInput.partial()),
  quotaDelete: ep('DELETE', '/api/quotas/:id', 'admin', Ok),
  extensionRequests: ep('GET', '/api/extension-requests', 'admin', z.array(X.ExtensionRequest), z.object({ status: X.ExtensionRequest.shape.status.optional() })),
  extensionDecide: ep('POST', '/api/extension-requests/:id', 'admin', X.ExtensionRequest, X.ExtensionDecisionInput),
  presence: ep('GET', '/api/presence/timeline', 'admin', X.PresenceTimeline, z.object({ from: z.coerce.number(), to: z.coerce.number() })),

  // ── member portal ─────────────────────────────────────────────
  meSummary: ep('GET', '/api/me/summary', 'member', X.MeSummary),
  meRequest: ep('POST', '/api/me/requests', 'member', X.ExtensionRequest, X.ExtensionRequestInput),

  // ── automation ────────────────────────────────────────────────
  rules: ep('GET', '/api/rules', 'admin', z.array(M.Rule)),
  rule: ep('GET', '/api/rules/:id', 'admin', M.Rule),
  ruleCreate: ep('POST', '/api/rules', 'admin', M.Rule, M.RuleInput),
  ruleUpdate: ep('PATCH', '/api/rules/:id', 'admin', M.Rule, M.RuleInput.partial()),
  ruleDelete: ep('DELETE', '/api/rules/:id', 'admin', Ok),
  ruleTest: ep('POST', '/api/rules/:id/test', 'admin', M.RuleRun, z.object({ dryRun: z.boolean().default(true) }), 'Run actions now with a synthetic event.'),
  ruleRuns: ep('GET', '/api/rules/runs', 'admin', Paged(M.RuleRun), z.object({ ruleId: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().default(50) })),
  watchdogs: ep('GET', '/api/watchdogs', 'admin', z.array(M.PoeWatchdog)),
  watchdogPorts: ep('GET', '/api/watchdogs/ports', 'admin', z.array(M.PoePort)),
  watchdogCreate: ep('POST', '/api/watchdogs', 'admin', M.PoeWatchdog, M.PoeWatchdogInput),
  watchdogUpdate: ep('PATCH', '/api/watchdogs/:id', 'admin', M.PoeWatchdog, M.PoeWatchdogInput.partial()),
  watchdogDelete: ep('DELETE', '/api/watchdogs/:id', 'admin', Ok),
  watchdogCycle: ep('POST', '/api/watchdogs/:id/cycle', 'admin', M.PoeWatchdog, undefined, 'Manual power-cycle now.'),
  watchdogEvents: ep('GET', '/api/watchdogs/:id/events', 'admin', z.array(M.WatchdogEvent)),
  wlans: ep('GET', '/api/wlans', 'admin', z.array(M.Wlan)),
  guestWifi: ep('GET', '/api/guest-wifi', 'admin', M.GuestWifi),
  guestWifiSave: ep('PUT', '/api/guest-wifi', 'admin', M.GuestWifi, M.GuestWifiInput),
  guestWifiRotate: ep('POST', '/api/guest-wifi/rotate', 'admin', M.GuestWifi),
  guestWifiKioskReset: ep('POST', '/api/guest-wifi/kiosk-token', 'admin', M.GuestWifi, undefined, 'Regenerate kiosk token (invalidates old URL).'),
  kiosk: ep('GET', '/api/kiosk/:token', 'public', M.KioskPayload),
  wolTargets: ep('GET', '/api/wol', 'admin', z.array(M.WolTarget)),
  wolCreate: ep('POST', '/api/wol', 'admin', M.WolTarget, M.WolTargetInput),
  wolUpdate: ep('PATCH', '/api/wol/:id', 'admin', M.WolTarget, M.WolTargetInput.partial()),
  wolDelete: ep('DELETE', '/api/wol/:id', 'admin', Ok),
  wolWake: ep('POST', '/api/wol/:id/wake', 'admin', M.WolTarget),

  // ── insight ───────────────────────────────────────────────────
  snapshots: ep('GET', '/api/snapshots', 'admin', Paged(I.Snapshot), z.object({ cursor: z.string().optional(), limit: z.coerce.number().default(50) })),
  snapshotCreate: ep('POST', '/api/snapshots', 'admin', I.Snapshot, z.object({ note: z.string().max(200).optional() })),
  snapshotDelete: ep('DELETE', '/api/snapshots/:id', 'admin', Ok),
  snapshotDiff: ep('GET', '/api/snapshots/diff', 'admin', I.SnapshotDiff, z.object({ from: z.string(), to: z.string().optional() })),
  snapshotItem: ep('GET', '/api/snapshots/:id/items/:resource/:itemId', 'admin', I.SnapshotItem),
  snapshotRestore: ep('POST', '/api/snapshots/:id/restore', 'admin', I.RestorePlan, I.RestoreInput),
  audit: ep('GET', '/api/audit', 'admin', Paged(I.AuditEvent), I.AuditQuery),
  ispReport: ep('GET', '/api/reports/isp', 'admin', I.IspReport, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) })),
  usageReport: ep('GET', '/api/reports/usage', 'admin', I.UsageReport, z.object({ range: z.enum(['7d', '30d', 'month']).default('7d'), month: z.string().optional() })),
  speedtest: ep('GET', '/api/reports/speedtest', 'admin', I.SpeedtestStatus),
  speedtestStart: ep('POST', '/api/reports/speedtest', 'admin', I.SpeedtestStatus),

  // ── notifications & settings ──────────────────────────────────
  channels: ep('GET', '/api/notifications/channels', 'admin', z.array(S.NotificationChannel)),
  channelCreate: ep('POST', '/api/notifications/channels', 'admin', S.NotificationChannel, S.NotificationChannelInput),
  channelUpdate: ep('PATCH', '/api/notifications/channels/:id', 'admin', S.NotificationChannel, S.NotificationChannelInput.partial()),
  channelDelete: ep('DELETE', '/api/notifications/channels/:id', 'admin', Ok),
  channelTest: ep('POST', '/api/notifications/channels/:id/test', 'admin', Ok),
  vapidKey: ep('GET', '/api/push/vapid', 'any', z.object({ publicKey: z.string() })),
  pushSubscribe: ep('POST', '/api/push/subscribe', 'any', Ok, S.PushSubscriptionInput),
  pushUnsubscribe: ep('POST', '/api/push/unsubscribe', 'any', Ok, z.object({ endpoint: z.string() })),
  pushAction: ep('POST', '/api/push/action', 'public', Ok, z.object({ token: z.string() }), 'Signed one-time token from a notification action button.'),
  settings: ep('GET', '/api/settings', 'admin', S.Settings),
  settingsSave: ep('PATCH', '/api/settings', 'admin', S.Settings, S.SettingsInput),
  networks: ep('GET', '/api/networks', 'admin', z.array(z.object({ id: z.string(), name: z.string(), purpose: z.string(), subnet: z.string().nullable(), vlan: z.number().nullable() }))),
} as const satisfies Record<string, Endpoint>

export type ApiName = keyof typeof api
export type ApiOutput<K extends ApiName> = z.infer<(typeof api)[K]['output']>
