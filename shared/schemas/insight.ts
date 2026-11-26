import { z } from 'zod'
import { Id, Ts } from './common'

/* ───────────────────────────── Snapshots ───────────────────────────── */

/** Resource collections captured in a snapshot. */
export const SnapshotResource = z.enum([
  'trafficroutes',
  'objects',
  'firewall-policies',
  'firewall-zones',
  'networkconf',
  'wlanconf',
  'portforward',
  'routing',
  'static-dns',
  'qos-rules',
  'users',
  'portconf',
])

export const Snapshot = z.object({
  id: Id,
  ts: Ts,
  trigger: z.enum(['scheduled', 'pre-write', 'manual', 'pre-restore']),
  note: z.string().nullable(),
  networkVersion: z.string().nullable(),
  complete: z.boolean(),
  /** Resources that failed to read (snapshot is then incomplete). */
  failed: z.array(SnapshotResource),
  counts: z.record(z.string(), z.number()),
  /** Number of changed items vs. the previous snapshot. */
  changeCount: z.number().int().nullable(),
  sizeBytes: z.number().int(),
})

export const FieldChange = z.object({
  path: z.string(), // "network_id", "target_devices[0].client_mac"
  before: z.unknown(),
  after: z.unknown(),
  /** Human label for the value, e.g. egress name for a network_id. */
  beforeLabel: z.string().nullable(),
  afterLabel: z.string().nullable(),
  secret: z.boolean(), // value redacted
})

export const DiffChange = z.object({
  resource: SnapshotResource,
  itemId: z.string(),
  itemLabel: z.string(),
  kind: z.enum(['added', 'removed', 'modified']),
  fields: z.array(FieldChange),
  /** Semantic one-liner, e.g. "路由「Kids」出口 WAN1 → Tokyo WG". Server provides an i18n key + params. */
  summaryKey: z.string(),
  summaryParams: z.record(z.string(), z.string()),
  restorable: z.boolean(),
})

/** GET /api/snapshots/diff?from=&to= (to omitted = live controller state). */
export const SnapshotDiff = z.object({
  fromId: Id,
  toId: Id.nullable(),
  changes: z.array(DiffChange),
})

/** GET /api/snapshots/:id/items/:resource/:itemId — redacted document. */
export const SnapshotItem = z.object({
  resource: SnapshotResource,
  itemId: z.string(),
  label: z.string(),
  doc: z.record(z.string(), z.unknown()),
})

export const RestoreInput = z.object({
  items: z.array(z.object({ resource: SnapshotResource, itemId: z.string() })).min(1),
  dryRun: z.boolean().default(true),
})

export const RestorePlan = z.object({
  dryRun: z.boolean(),
  steps: z.array(z.object({
    resource: SnapshotResource,
    itemId: z.string(),
    label: z.string(),
    method: z.enum(['PUT', 'POST', 'DELETE']),
    path: z.string(),
    /** Redacted preview of the body. */
    body: z.record(z.string(), z.unknown()).nullable(),
    supported: z.boolean(),
    reason: z.string().nullable(),
    result: z.enum(['pending', 'applied', 'failed', 'skipped']),
    error: z.string().nullable(),
  })),
})

/* ───────────────────────────── Audit ───────────────────────────── */

export const AuditActor = z.object({
  type: z.enum(['unifire', 'user', 'external', 'unifi-log', 'system', 'rule']),
  id: z.string().nullable(),
  name: z.string().nullable(),
})

export const AuditCategory = z.enum(['route', 'egress', 'client', 'approval', 'quota', 'pause', 'config', 'auth', 'rule', 'poe', 'wifi', 'wol', 'snapshot', 'system'])

export const AuditEvent = z.object({
  id: Id,
  ts: Ts,
  actor: AuditActor,
  category: AuditCategory,
  /** Dotted action, e.g. "route.switched", "client.blocked", "config.changed". */
  action: z.string(),
  severity: z.enum(['info', 'success', 'warning', 'error']),
  target: z.object({ type: z.string(), id: z.string(), label: z.string() }).nullable(),
  /** i18n key + params so the UI can render in either language. */
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.string()),
  diff: z.array(FieldChange).nullable(),
  dryRun: z.boolean(),
})

/** GET /api/audit?category=&actor=&q=&from=&to=&cursor=&limit= */
export const AuditQuery = z.object({
  category: AuditCategory.optional(),
  actor: AuditActor.shape.type.optional(),
  q: z.string().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/* ───────────────────────────── Reports ───────────────────────────── */

export const Outage = z.object({ start: Ts, end: Ts.nullable(), durationSec: z.number() })

/** GET /api/reports/isp?month=2026-11 */
export const IspReport = z.object({
  month: z.string(),
  generatedAt: Ts,
  wans: z.array(z.object({
    egressId: Id,
    name: z.string(),
    uptimePct: z.number().nullable(),
    latencyP50: z.number().nullable(),
    latencyP95: z.number().nullable(),
    lossPct: z.number().nullable(),
    outages: z.array(Outage),
    daily: z.array(z.object({ date: z.string(), uptimePct: z.number().nullable(), latencyP50: z.number().nullable() })),
    publicIps: z.array(z.object({ ip: z.string(), firstSeen: Ts, lastSeen: Ts })),
  })),
  speedtests: z.array(z.object({ ts: Ts, egressId: Id.nullable(), downMbps: z.number(), upMbps: z.number(), latencyMs: z.number().nullable() })),
  /** VPN egress summary for the same month. */
  vpns: z.array(z.object({ egressId: Id, name: z.string(), uptimePct: z.number().nullable(), latencyP50: z.number().nullable() })),
})

/** GET /api/reports/usage?range=7d|30d|month&month= */
export const UsageReport = z.object({
  from: Ts,
  to: Ts,
  totals: z.object({ rxBytes: z.number(), txBytes: z.number() }),
  daily: z.array(z.object({ date: z.string(), rxBytes: z.number(), txBytes: z.number() })),
  topClients: z.array(z.object({ mac: z.string(), name: z.string(), personId: Id.nullable(), bytes: z.number(), activeMinutes: z.number() })),
  people: z.array(z.object({ personId: Id, name: z.string(), bytes: z.number(), activeMinutes: z.number() })),
  /** Hour-of-week heatmap [day][hour] in bytes. */
  heatmap: z.array(z.array(z.number()).length(24)).length(7),
})

/** POST /api/reports/speedtest — trigger gateway speed test (if capability ok). */
export const SpeedtestStatus = z.object({
  running: z.boolean(),
  startedAt: Ts.nullable(),
  last: z.object({ ts: Ts, downMbps: z.number(), upMbps: z.number(), latencyMs: z.number().nullable() }).nullable(),
})

export type SnapshotResourceT = z.infer<typeof SnapshotResource>
export type SnapshotT = z.infer<typeof Snapshot>
export type FieldChangeT = z.infer<typeof FieldChange>
export type DiffChangeT = z.infer<typeof DiffChange>
export type SnapshotDiffT = z.infer<typeof SnapshotDiff>
export type SnapshotItemT = z.infer<typeof SnapshotItem>
export type RestorePlanT = z.infer<typeof RestorePlan>
export type AuditEventT = z.infer<typeof AuditEvent>
export type AuditCategoryT = z.infer<typeof AuditCategory>
export type IspReportT = z.infer<typeof IspReport>
export type UsageReportT = z.infer<typeof UsageReport>
export type SpeedtestStatusT = z.infer<typeof SpeedtestStatus>
