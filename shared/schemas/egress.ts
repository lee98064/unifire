import { z } from 'zod'
import { Id, Ts } from './common'

/** An egress = a UniFi WAN or outbound VPN client (networkconf `_id`). */
export const EgressKind = z.enum(['wan', 'wireguard', 'openvpn', 'other'])
export const HealthStatus = z.enum(['healthy', 'degraded', 'down', 'unknown'])

export const EgressHealth = z.object({
  status: HealthStatus,
  latencyMs: z.number().nullable(),
  lossPct: z.number().min(0).max(100).nullable(),
  jitterMs: z.number().nullable(),
  lastCheckAt: Ts.nullable(),
  /** When the current status started. */
  since: Ts.nullable(),
  /** Where the health came from: own probe route, or UniFi-reported WAN status only. */
  source: z.enum(['probe', 'unifi', 'none']),
})

export const PublicIp = z.object({
  ip: z.string(),
  country: z.string().nullable(), // ISO-3166 alpha-2 from Cloudflare trace `loc`
  colo: z.string().nullable(), // Cloudflare colo (IATA)
  checkedAt: Ts,
  changed: z.boolean(), // differs from previous check
})

export const Egress = z.object({
  id: Id, // UniFi networkconf _id
  name: z.string(),
  kind: EgressKind,
  /** WAN group for WANs ("WAN", "WAN2", "WAN3"). */
  wanGroup: z.string().nullable(),
  /** Stable identity color (hex) assigned by Unifire, editable. */
  color: z.string(),
  /** Enabled in UniFi. */
  enabled: z.boolean(),
  probe: z.object({
    enabled: z.boolean(),
    ip: z.string().nullable(),
    routeId: z.string().nullable(), // UniFi trafficroute _id of the probe route
    state: z.enum(['ok', 'missing', 'provisioning', 'disabled', 'error']),
  }),
  health: EgressHealth,
  publicIp: PublicIp.nullable(),
  /** How many UniFi routes currently egress here (all, not only managed). */
  routeCount: z.number().int(),
})

export const EgressUpdateInput = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  probeEnabled: z.boolean().optional(),
})

export const EgressSample = z.object({
  ts: Ts,
  latencyMs: z.number().nullable(),
  lossPct: z.number().nullable(),
  status: HealthStatus,
})

/** GET /api/egresses/:id/history?range=24h|7d|30d */
export const EgressHistory = z.object({
  egressId: Id,
  range: z.enum(['1h', '24h', '7d', '30d']),
  samples: z.array(EgressSample),
  ipChecks: z.array(PublicIp),
  incidents: z.array(z.object({ start: Ts, end: Ts.nullable(), status: HealthStatus })),
})

/** POST /api/egresses/sweep → kicks off rotating public-IP sweep. */
export const SweepStatus = z.object({
  running: z.boolean(),
  startedAt: Ts.nullable(),
  finishedAt: Ts.nullable(),
  current: Id.nullable(),
  done: z.number().int(),
  total: z.number().int(),
  results: z.array(z.object({ egressId: Id, ok: z.boolean(), ip: z.string().nullable(), country: z.string().nullable(), error: z.string().nullable() })),
})

/** GET /api/probes */
export const ProbeOverview = z.object({
  selfMac: z.string().nullable(),
  ipPool: z.array(z.string()),
  sweepIp: z.string(),
  routes: z.array(z.object({ egressId: Id, routeId: z.string().nullable(), ip: z.string().nullable(), state: z.enum(['ok', 'missing', 'provisioning', 'disabled', 'error']), detail: z.string().nullable() })),
})

export type EgressT = z.infer<typeof Egress>
export type EgressKindT = z.infer<typeof EgressKind>
export type HealthStatusT = z.infer<typeof HealthStatus>
export type EgressHealthT = z.infer<typeof EgressHealth>
export type PublicIpT = z.infer<typeof PublicIp>
export type EgressHistoryT = z.infer<typeof EgressHistory>
export type SweepStatusT = z.infer<typeof SweepStatus>
export type ProbeOverviewT = z.infer<typeof ProbeOverview>
