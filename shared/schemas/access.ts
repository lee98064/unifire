import { z } from 'zod'
import { Id, Mac, Ts, WeeklyWindow } from './common'

/* ───────────────────────────── Clients ───────────────────────────── */

export const ApprovalState = z.enum(['approved', 'pending', 'blocked', 'ignored'])

export const BlockSource = z.enum(['pause', 'bedtime', 'quota', 'approval', 'rule', 'manual', 'unifi'])

/** One reason a client is (or should be) blocked. `unifi` = blocked in UniFi by someone else (never auto-unblocked). */
export const BlockReason = z.object({
  source: BlockSource,
  /** Ref id: personId / quotaId / ruleId … */
  refId: Id.nullable(),
  label: z.string(),
  until: Ts.nullable(),
})

export const Client = z.object({
  mac: Mac,
  /** Effective display name: Unifire alias > UniFi name > hostname > vendor > MAC. */
  displayName: z.string(),
  unifiName: z.string().nullable(),
  hostname: z.string().nullable(),
  vendor: z.string().nullable(),
  ip: z.string().nullable(),
  fixedIp: z.string().nullable(),
  networkId: Id.nullable(),
  networkName: z.string().nullable(),
  online: z.boolean(),
  wired: z.boolean(),
  /** AP or switch the client hangs off. */
  uplinkMac: Mac.nullable(),
  uplinkName: z.string().nullable(),
  switchPort: z.number().int().nullable(),
  ssid: z.string().nullable(),
  signal: z.number().nullable(), // dBm
  randomizedMac: z.boolean(),
  firstSeen: Ts.nullable(),
  lastSeen: Ts.nullable(),
  personId: Id.nullable(),
  approval: ApprovalState,
  blocked: z.boolean(),
  blockReasons: z.array(BlockReason),
  note: z.string().nullable(),
  /** Live counters (since association) and today's accounted usage. */
  rxRateBps: z.number().nullable(),
  txRateBps: z.number().nullable(),
  today: z.object({ activeMinutes: z.number(), bytes: z.number() }),
  managedRouteIds: z.array(Id),
})

export const ClientUpdateInput = z.object({
  alias: z.string().max(80).nullable().optional(),
  personId: Id.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
})

export const ClientActionInput = z.object({
  action: z.enum(['block', 'unblock', 'kick']),
  /** For block: auto-unblock after N minutes. */
  minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
})

/** GET /api/clients/:mac/usage?range=24h|7d|30d */
export const ClientUsage = z.object({
  mac: Mac,
  range: z.enum(['24h', '7d', '30d']),
  buckets: z.array(z.object({ ts: Ts, rxBytes: z.number(), txBytes: z.number(), activeMinutes: z.number() })),
  totals: z.object({ rxBytes: z.number(), txBytes: z.number(), activeMinutes: z.number() }),
})

/** Pending approval card (GET /api/approvals). */
export const ApprovalItem = Client.extend({
  detectedAt: Ts,
  /** How the client was blocked while pending (strict mode). */
  quarantined: z.boolean(),
})

export const ApprovalDecisionInput = z.object({
  decision: z.enum(['approve', 'block', 'ignore']),
  alias: z.string().max(80).optional(),
  personId: Id.nullable().optional(),
})

/* ───────────────────────────── People ───────────────────────────── */

export const Person = z.object({
  id: Id,
  name: z.string(),
  /** Emoji or 1–2 letters. */
  avatar: z.string(),
  color: z.string(),
  deviceMacs: z.array(Mac),
  /** Devices used for presence detection (subset of deviceMacs, usually phones). */
  presenceMacs: z.array(Mac),
  groupIds: z.array(Id),
  userId: Id.nullable(),
  presence: z.object({ home: z.boolean(), since: Ts.nullable() }),
  pause: z.object({ active: z.boolean(), until: Ts.nullable(), reason: z.string().nullable() }),
  bedtime: z.array(WeeklyWindow),
  /** Temporary allowance currently overriding bedtime/pause/quota blocks. */
  allowanceUntil: Ts.nullable(),
  createdAt: Ts,
})

export const PersonInput = z.object({
  name: z.string().min(1).max(40),
  avatar: z.string().max(8).default('🙂'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  deviceMacs: z.array(Mac).default([]),
  presenceMacs: z.array(Mac).default([]),
  groupIds: z.array(Id).default([]),
  bedtime: z.array(WeeklyWindow).default([]),
})

export const Group = z.object({ id: Id, name: z.string(), color: z.string(), personIds: z.array(Id) })
export const GroupInput = z.object({ name: z.string().min(1).max(40), color: z.string(), personIds: z.array(Id).default([]) })

/** POST /api/people/:id/pause — minutes null = until manually resumed. POST .../resume clears. */
export const PauseInput = z.object({
  minutes: z.number().int().min(1).max(60 * 24 * 7).nullable(),
  reason: z.string().max(120).optional(),
})

/** POST /api/people/:id/allow — temporary allowance ("再給 30 分鐘"). */
export const AllowanceInput = z.object({ minutes: z.number().int().min(5).max(60 * 12) })

/* ───────────────────────────── Quotas ───────────────────────────── */

export const QuotaScope = z.object({ type: z.enum(['person', 'group', 'client']), id: Id })
export const QuotaMetric = z.enum(['activeMinutes', 'bytes'])
export const QuotaPeriod = z.enum(['daily', 'weekly', 'monthly'])
export const QuotaAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block') }),
  z.object({ type: z.literal('egress'), egressId: Id }),
  z.object({ type: z.literal('notify') }),
])

export const Quota = z.object({
  id: Id,
  name: z.string(),
  scope: QuotaScope,
  metric: QuotaMetric,
  period: QuotaPeriod,
  /** minutes (activeMinutes) or bytes. */
  limit: z.number().positive(),
  /** Per-weekday override of the limit (index 0 = Monday); null = use limit. */
  weekdayLimits: z.array(z.number().positive().nullable()).length(7).nullable(),
  warnAtPct: z.number().min(1).max(99).default(80),
  action: QuotaAction,
  enabled: z.boolean(),
})

export const QuotaInput = Quota.omit({ id: true })

export const QuotaStatus = z.object({
  quotaId: Id,
  name: z.string(),
  metric: QuotaMetric,
  period: QuotaPeriod,
  used: z.number(),
  limit: z.number(),
  /** Extra granted via approved extension requests for the current period. */
  bonus: z.number(),
  pct: z.number(),
  state: z.enum(['ok', 'warning', 'exceeded']),
  resetsAt: Ts,
})

export const ExtensionRequest = z.object({
  id: Id,
  personId: Id,
  quotaId: Id.nullable(),
  /** minutes for time quotas; bytes for data quotas; minutes of allowance otherwise. */
  amount: z.number().positive(),
  reason: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  createdAt: Ts,
  decidedAt: Ts.nullable(),
  decidedBy: z.string().nullable(),
})

export const ExtensionRequestInput = z.object({
  quotaId: Id.nullable().default(null),
  amount: z.number().positive(),
  reason: z.string().max(200).optional(),
})

export const ExtensionDecisionInput = z.object({
  decision: z.enum(['approve', 'deny']),
  /** Admin may grant a different amount. */
  amount: z.number().positive().optional(),
})

/* ───────────────────────────── Presence ───────────────────────────── */

export const PresenceSession = z.object({ start: Ts, end: Ts.nullable(), mac: Mac })

/** GET /api/presence/timeline?from=&to= */
export const PresenceTimeline = z.object({
  from: Ts,
  to: Ts,
  people: z.array(z.object({ personId: Id, sessions: z.array(PresenceSession) })),
})

/* ───────────────────────────── Member portal ───────────────────────────── */

/** GET /api/me/summary (member accounts; admins get their bound person if any). */
export const MeSummary = z.object({
  person: Person.nullable(),
  devices: z.array(Client),
  quotas: z.array(QuotaStatus),
  requests: z.array(ExtensionRequest),
  blockedNow: z.boolean(),
  blockReasons: z.array(BlockReason),
  nextBedtime: z.object({ start: Ts, end: Ts }).nullable(),
})

export type ClientT = z.infer<typeof Client>
export type ApprovalStateT = z.infer<typeof ApprovalState>
export type BlockReasonT = z.infer<typeof BlockReason>
export type BlockSourceT = z.infer<typeof BlockSource>
export type ClientUsageT = z.infer<typeof ClientUsage>
export type ApprovalItemT = z.infer<typeof ApprovalItem>
export type PersonT = z.infer<typeof Person>
export type GroupT = z.infer<typeof Group>
export type QuotaT = z.infer<typeof Quota>
export type QuotaStatusT = z.infer<typeof QuotaStatus>
export type QuotaActionT = z.infer<typeof QuotaAction>
export type ExtensionRequestT = z.infer<typeof ExtensionRequest>
export type PresenceTimelineT = z.infer<typeof PresenceTimeline>
export type MeSummaryT = z.infer<typeof MeSummary>
