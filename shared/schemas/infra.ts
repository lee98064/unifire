import { z } from 'zod'
import { Id, Mac, Ts, WeeklyWindow } from './common'

/*
 * Phase 2 — infrastructure (gateway / switches / APs). See docs/PLAN-infra.md.
 * All MACs lower-case; all timestamps epoch ms; all rates bits per second (bps) unless named *Bytes.
 * Any field the controller does not report is null (never 0 as a placeholder).
 */

/* ───────────────────────────── Devices ───────────────────────────── */

export const DeviceType = z.enum(['gateway', 'switch', 'ap', 'other'])

/** Normalised from stat/device `state` (0 offline, 1 connected, 4 upgrading, 5 provisioning, 6 heartbeat missed, 7 adopting, …). */
export const DeviceState = z.enum(['online', 'offline', 'restarting', 'upgrading', 'provisioning', 'adopting', 'unknown'])

export const DeviceIssueKind = z.enum([
  'offline',
  'overheat',
  'high_cpu',
  'high_mem',
  'port_issue',
  'firmware_available',
  'unexpected_reboot', // within the last 24 h
  'bottleneck', // uplink flagged by topology analysis
])

export const DeviceIssue = z.object({
  kind: DeviceIssueKind,
  severity: z.enum(['info', 'warning', 'error']),
  /** i18n key + params, e.g. infra.issue.overheat {temp} */
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.string()),
})

export const DeviceUplink = z.object({
  /** Upstream UniFi device (null when unknown, or for the gateway). */
  mac: Mac.nullable(),
  name: z.string().nullable(),
  /** Port index on the upstream device. */
  remotePort: z.number().int().nullable(),
  /** Port index on this device used as uplink. */
  localPort: z.number().int().nullable(),
  type: z.enum(['wire', 'wireless', 'unknown']),
  speedMbps: z.number().nullable(),
  fullDuplex: z.boolean().nullable(),
  /** Mesh uplink signal (dBm). */
  signal: z.number().nullable(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
})

export const InfraDevice = z.object({
  mac: Mac,
  /** UniFi `_id` (needed for rest/device writes). */
  unifiId: Id.nullable(),
  /** Effective name: UniFi name > model name > MAC. */
  name: z.string(),
  /** Raw model code, e.g. "UDMPRO", "USL8LP", "U7PG2". */
  model: z.string().nullable(),
  /** Human model name when known, e.g. "UniFi Dream Machine Pro". */
  modelName: z.string().nullable(),
  type: DeviceType,
  state: DeviceState,
  ip: z.string().nullable(),
  firmware: z.string().nullable(),
  /** Firmware the controller offers as an upgrade (null = up to date / unknown). */
  upgradeTo: z.string().nullable(),
  uptimeSec: z.number().nullable(),
  firstSeen: Ts,
  lastSeen: Ts.nullable(),
  cpuPct: z.number().nullable(),
  memPct: z.number().nullable(),
  tempC: z.number().nullable(),
  /** Clients directly attached (num_sta). */
  clients: z.number().int().nullable(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
  uplink: DeviceUplink.nullable(),
  /** Switch/gateway port summary; null for devices without a port table. */
  ports: z.object({ total: z.number().int(), up: z.number().int(), poe: z.number().int(), issues: z.number().int() }).nullable(),
  /** PoE power sourced by this device; null when it has no PoE ports. */
  poe: z.object({ usedW: z.number().nullable(), budgetW: z.number().nullable() }).nullable(),
  /** Radio band labels for APs (e.g. ["2.4", "5", "6"]). */
  bands: z.array(z.string()),
  roomId: Id.nullable(),
  /** Fraction of the last 24 h the device was online (from Unifire samples; null until enough data). */
  availability24h: z.number().min(0).max(1).nullable(),
  lastReboot: z.object({ ts: Ts, unexpected: z.boolean() }).nullable(),
  /** Locate LED currently blinking (started by Unifire). */
  locating: z.boolean(),
  issues: z.array(DeviceIssue),
})

export const Radio = z.object({
  band: z.enum(['2.4', '5', '6', '60', 'unknown']),
  /** Raw UniFi radio name (ng / na / 6e …). */
  radio: z.string().nullable(),
  channel: z.number().int().nullable(),
  widthMhz: z.number().int().nullable(),
  txPowerDbm: z.number().nullable(),
  /** Channel utilisation total (cu_total, %). */
  utilizationPct: z.number().nullable(),
  /** Utilisation caused by other networks (%), when derivable. */
  interferencePct: z.number().nullable(),
  /** TX retries (%). */
  retriesPct: z.number().nullable(),
  clients: z.number().int().nullable(),
  satisfaction: z.number().nullable(),
})

/* ───────────────────────────── Ports ───────────────────────────── */

export const PortMedia = z.enum(['rj45', 'sfp', 'sfp+', 'sfp28', 'qsfp', 'unknown'])

export const PortIssueKind = z.enum(['downgrade', 'errors', 'flapping', 'new_device', 'peer_changed'])

/** Why a port may (not) get a PoE schedule / override. */
export const PoeSafetyReason = z.enum([
  'not_poe',
  'uplink',
  'downstream_devices', // a switch or mesh child sits behind this port
  'unifire_host', // the Unifire host is behind this port
  'gateway_path', // the port is on the path between Unifire and the gateway
  'powers_ap', // allowed only with explicit acknowledgement
])

export const PortPeer = z.object({
  /** device = adopted UniFi device, client = a known client, unknown = MAC seen but not known. */
  kind: z.enum(['device', 'client', 'unknown']),
  mac: Mac.nullable(),
  name: z.string().nullable(),
  personId: Id.nullable(),
  /** Number of MACs currently seen behind the port (>1 = unmanaged switch / hub / VMs). */
  count: z.number().int(),
})

export const PortView = z.object({
  switchMac: Mac,
  idx: z.number().int(),
  name: z.string().nullable(),
  media: PortMedia,
  enabled: z.boolean(),
  up: z.boolean(),
  speedMbps: z.number().nullable(),
  /** Highest speed the port supports (from speed_caps). */
  maxSpeedMbps: z.number().nullable(),
  /** Highest speed previously negotiated with the current peer (Unifire baseline). */
  baselineSpeedMbps: z.number().nullable(),
  fullDuplex: z.boolean().nullable(),
  /** This port is the device's own uplink. */
  isUplink: z.boolean(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
  /** RX+TX errors as % of packets over the last hour. */
  errorRatePct: z.number().nullable(),
  flaps1h: z.number().int(),
  stp: z.string().nullable(),
  poe: z.object({
    capable: z.boolean(),
    /** UniFi poe_mode: auto | off | pasv24 | passthrough … */
    mode: z.string().nullable(),
    powerW: z.number().nullable(),
    poeClass: z.string().nullable(),
    /** A Unifire PoE schedule covers this port. */
    scheduleId: Id.nullable(),
    /** Unifire currently holds the port powered off (schedule or override). */
    heldOffByUnifire: z.boolean(),
  }).nullable(),
  poeSafety: z.object({
    allowed: z.boolean(),
    reasons: z.array(PoeSafetyReason),
    requiresAck: z.boolean(),
  }),
  peer: PortPeer.nullable(),
  issues: z.array(PortIssueKind),
})

export const PortEvent = z.object({
  id: Id,
  ts: Ts,
  switchMac: Mac,
  switchName: z.string(),
  portIdx: z.number().int(),
  portName: z.string().nullable(),
  kind: z.enum(['downgrade', 'recovered', 'errors', 'flapping', 'new_device', 'peer_changed']),
  severity: z.enum(['info', 'warning', 'error']),
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.string()),
  /** Extra facts, e.g. { fromMbps, toMbps, peerMac, errorRatePct, flaps }. */
  data: z.record(z.string(), z.unknown()),
  acknowledged: z.boolean(),
})

export const PortEventQuery = z.object({
  switchMac: Mac.optional(),
  portIdx: z.coerce.number().int().optional(),
  unacknowledged: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

export const PortEventUpdateInput = z.object({ acknowledged: z.boolean() })

/** Acknowledge every open event (optionally for one switch). */
export const PortEventAckAllInput = z.object({ switchMac: Mac.optional() })

export const SeriesRange = z.enum(['24h', '7d', '30d', '90d'])

export const PortSeriesPoint = z.object({
  ts: Ts,
  /** Fraction of the bucket the link was up. */
  up: z.number().min(0).max(1).nullable(),
  speedMbps: z.number().nullable(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
  errors: z.number().nullable(),
  drops: z.number().nullable(),
  poeW: z.number().nullable(),
})

/** GET /api/ports/:switchMac/:idx?range= — drawer content for one port. */
export const PortDetail = z.object({
  port: PortView,
  range: SeriesRange,
  bucketSec: z.number().int(),
  series: z.array(PortSeriesPoint),
  /** Every MAC ever seen on this port, most recent first. */
  peers: z.array(z.object({
    mac: Mac,
    name: z.string().nullable(),
    personId: Id.nullable(),
    firstSeen: Ts,
    lastSeen: Ts,
    maxSpeedMbps: z.number().nullable(),
  })),
  events: z.array(PortEvent),
})

/* ───────────────────────────── Device detail & history ───────────────────────────── */

export const DeviceTransition = z.object({
  ts: Ts,
  from: DeviceState.nullable(),
  to: DeviceState,
  reason: z.enum(['unexpected_reboot', 'unifire_restart', 'upgrade', 'offline', 'online', 'state', 'adopted']).nullable(),
  /** For offline → online: how long it was down. */
  downSec: z.number().nullable(),
})

export const FirmwareChange = z.object({ ts: Ts, from: z.string().nullable(), to: z.string() })

export const InfraDeviceDetail = InfraDevice.extend({
  ports: z.array(PortView),
  radios: z.array(Radio),
  /** Adopted devices directly uplinked to this one. */
  downstream: z.array(z.object({ mac: Mac, name: z.string(), type: DeviceType, viaPort: z.number().int().nullable() })),
  transitions: z.array(DeviceTransition),
  firmwareHistory: z.array(FirmwareChange),
  portEvents: z.array(PortEvent),
  /** AP only: roams into / out of this AP in the last 24 h. */
  roams24h: z.object({ in: z.number().int(), out: z.number().int() }).nullable(),
  /** PoE energy sourced by this device. */
  energy: z.object({ todayWh: z.number(), monthWh: z.number() }).nullable(),
})

export const DeviceSeriesPoint = z.object({
  ts: Ts,
  /** Fraction of the bucket the device was online. */
  online: z.number().min(0).max(1).nullable(),
  cpuPct: z.number().nullable(),
  memPct: z.number().nullable(),
  tempC: z.number().nullable(),
  clients: z.number().nullable(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
  poeW: z.number().nullable(),
})

export const DeviceSeries = z.object({
  mac: Mac,
  range: SeriesRange,
  bucketSec: z.number().int(),
  points: z.array(DeviceSeriesPoint),
})

export const DeviceEvents = z.object({
  transitions: z.array(DeviceTransition),
  firmware: z.array(FirmwareChange),
  portEvents: z.array(PortEvent),
})

export const DeviceUpdateInput = z.object({
  roomId: Id.nullable().optional(),
})

export const LocateInput = z.object({
  /** false = stop blinking now. */
  on: z.boolean().default(true),
  minutes: z.number().int().min(1).max(60).default(5),
})

/* ───────────────────────────── PoE schedules & energy ───────────────────────────── */

export const PoeScheduleStatus = z.enum([
  'ok', // actual == desired
  'pending', // write queued / waiting for read-back
  'preview', // mode=preview: computed only, never written
  'dry_run', // global dry-run: would write
  'drift', // someone changed the port in UniFi while Unifire held it → schedule paused
  'blocked', // safety rule forbids the port now (e.g. it became an uplink)
  'unqualified', // PoE writes not qualified yet
  'error',
  'disabled',
])

export const PoeSchedule = z.object({
  id: Id,
  name: z.string(),
  switchMac: Mac,
  switchName: z.string().nullable(),
  portIdx: z.number().int().min(1),
  portName: z.string().nullable(),
  /** What the port powers (current peer) — for display. */
  peerName: z.string().nullable(),
  /** Weekly windows during which the port is powered OFF (may cross midnight). */
  offWindows: z.array(WeeklyWindow).min(1),
  timezone: z.string(),
  /** preview = show what would happen, never write. active = enforce. */
  mode: z.enum(['preview', 'active']),
  enabled: z.boolean(),
  /** User confirmed powering off a UniFi AP is intended. Required when poeSafety.requiresAck. */
  acknowledgedAp: z.boolean(),
  state: z.object({
    status: PoeScheduleStatus,
    desired: z.enum(['on', 'off']),
    actual: z.enum(['on', 'off', 'unknown']),
    /** i18n key explaining status (blocked/drift/error), with params. */
    reasonKey: z.string().nullable(),
    reasonParams: z.record(z.string(), z.string()),
    nextChangeAt: Ts.nullable(),
    nextDesired: z.enum(['on', 'off']).nullable(),
    /** Off windows in the next 48 h. */
    upcoming: z.array(z.object({ start: Ts, end: Ts })),
    lastAppliedAt: Ts.nullable(),
  }),
  savings: z.object({
    offHoursPerWeek: z.number(),
    /** Average draw while on (W), from history. */
    avgW: z.number().nullable(),
    monthKwh: z.number().nullable(),
    monthCost: z.number().nullable(),
  }),
  createdAt: Ts,
})

export const PoeScheduleInput = z.object({
  name: z.string().min(1).max(80),
  switchMac: Mac,
  portIdx: z.number().int().min(1),
  offWindows: z.array(WeeklyWindow).min(1),
  timezone: z.string().default('Asia/Taipei'),
  mode: z.enum(['preview', 'active']).default('preview'),
  enabled: z.boolean().default(true),
  acknowledgedAp: z.boolean().default(false),
})

/** Temporary manual/rule override of one port; expires back to the schedule (or to "leave alone"). */
export const PoeOverride = z.object({
  switchMac: Mac,
  portIdx: z.number().int(),
  on: z.boolean(),
  endsAt: Ts.nullable(),
  source: z.enum(['manual', 'rule']),
  createdAt: Ts,
})

export const PoeOverrideInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    switchMac: Mac,
    portIdx: z.number().int().min(1),
    on: z.boolean(),
    /** null = until cleared. */
    minutes: z.number().int().min(1).max(10080).nullable().default(60),
    acknowledgedAp: z.boolean().default(false),
  }),
  z.object({ action: z.literal('clear'), switchMac: Mac, portIdx: z.number().int().min(1) }),
])

export const PoeQualification = z.object({
  qualified: z.boolean(),
  at: Ts.nullable(),
  switchMac: Mac.nullable(),
  portIdx: z.number().int().nullable(),
  error: z.string().nullable(),
})

/** POST /api/poe/qualify — off → read-back → on → read-back on a port the user chose. */
export const PoeQualifyInput = z.object({
  switchMac: Mac,
  portIdx: z.number().int().min(1),
  confirm: z.literal(true),
  acknowledgedAp: z.boolean().default(false),
})

/** GET /api/poe — everything the PoE page needs besides watchdogs/energy. */
export const PoeOverview = z.object({
  qualification: PoeQualification,
  schedules: z.array(PoeSchedule),
  overrides: z.array(PoeOverride),
  /** PoE-sourcing devices with their ports (for the faceplate picker). */
  switches: z.array(z.object({
    mac: Mac,
    name: z.string(),
    model: z.string().nullable(),
    budgetW: z.number().nullable(),
    usedW: z.number().nullable(),
    ports: z.array(PortView),
  })),
})

export const EnergyPeriod = z.enum(['day', 'week', 'month', 'year'])

export const EnergyQuery = z.object({
  period: EnergyPeriod.default('month'),
  /** Any timestamp inside the wanted period (default now). */
  at: z.coerce.number().int().optional(),
})

export const EnergyReport = z.object({
  period: EnergyPeriod,
  from: Ts,
  to: Ts,
  timezone: z.string(),
  ratePerKwh: z.number().nullable(),
  currency: z.string(),
  totalWh: z.number(),
  cost: z.number().nullable(),
  previousTotalWh: z.number().nullable(),
  /** Hourly buckets for day, daily for week/month, monthly for year. Wh per sourcing device MAC. */
  series: z.array(z.object({ ts: Ts, byDevice: z.record(z.string(), z.number()) })),
  byDevice: z.array(z.object({
    mac: Mac,
    name: z.string(),
    wh: z.number(),
    ports: z.array(z.object({ idx: z.number().int(), name: z.string().nullable(), peerName: z.string().nullable(), wh: z.number() })),
  })),
  /** Energy saved by PoE schedules in the period. */
  savings: z.array(z.object({ scheduleId: Id, name: z.string(), wh: z.number(), cost: z.number().nullable() })),
  /** Current total PoE draw (W). */
  liveW: z.number().nullable(),
  /** Fraction of the period with samples (gaps are not interpolated). */
  coverage: z.number().min(0).max(1),
})

/* ───────────────────────────── Topology ───────────────────────────── */

export const BottleneckKind = z.enum(['speed_below_capability', 'high_utilization', 'weak_mesh', 'half_duplex', 'errors'])

export const TopologyClient = z.object({
  mac: Mac,
  name: z.string(),
  personId: Id.nullable(),
  wired: z.boolean(),
  signal: z.number().nullable(),
  rxBps: z.number().nullable(),
  txBps: z.number().nullable(),
})

export const TopologyNode = z.object({
  /** 'internet' | 'egress:<id>' | 'dev:<mac>' | 'clients:<mac>' (wireless on AP) | 'clients:<mac>:<port>' (wired on port) */
  id: z.string(),
  kind: z.enum(['internet', 'egress', 'gateway', 'switch', 'ap', 'other', 'client_group']),
  label: z.string(),
  parentId: z.string().nullable(),
  mac: Mac.nullable(),
  egressId: Id.nullable(),
  model: z.string().nullable(),
  state: z.enum(['ok', 'warning', 'down', 'unknown']),
  /** Number of clients behind this node (devices: direct clients; groups: members). */
  clients: z.number().int(),
  /** People with at least one device at this node. */
  people: z.array(Id),
  poeW: z.number().nullable(),
  /** client_group only. */
  members: z.array(TopologyClient),
})

export const TopologyEdge = z.object({
  id: z.string(),
  /** Parent (upstream) node id. */
  source: z.string(),
  /** Child (downstream) node id. */
  target: z.string(),
  medium: z.enum(['wire', 'wireless', 'wan', 'vpn']),
  speedMbps: z.number().nullable(),
  maxSpeedMbps: z.number().nullable(),
  fullDuplex: z.boolean().nullable(),
  /** Toward the child. */
  downBps: z.number().nullable(),
  /** Toward the parent. */
  upBps: z.number().nullable(),
  utilizationPct: z.number().nullable(),
  signal: z.number().nullable(),
  /** Port on the parent device. */
  parentPort: z.number().int().nullable(),
  /** Port on the child device. */
  childPort: z.number().int().nullable(),
  poeW: z.number().nullable(),
  bottlenecks: z.array(BottleneckKind),
})

export const Topology = z.object({
  generatedAt: Ts,
  nodes: z.array(TopologyNode),
  edges: z.array(TopologyEdge),
  bottlenecks: z.array(z.object({
    edgeId: z.string(),
    kind: BottleneckKind,
    messageKey: z.string(),
    messageParams: z.record(z.string(), z.string()),
  })),
})

/* ───────────────────────────── Rooms & roaming ───────────────────────────── */

export const Room = z.object({
  id: Id,
  name: z.string(),
  floor: z.string().nullable(),
  /** Lucide icon name without prefix, e.g. "sofa", "bed-double". */
  icon: z.string().nullable(),
  color: z.string().nullable(),
  order: z.number().int(),
  apMacs: z.array(Mac),
  /** People currently in this room. */
  occupants: z.array(Id),
})

export const RoomInput = z.object({
  name: z.string().min(1).max(40),
  floor: z.string().max(40).nullable().default(null),
  icon: z.string().max(40).nullable().default(null),
  color: z.string().max(20).nullable().default(null),
  order: z.number().int().default(0),
})

export const RoomAssignInput = z.object({ apMac: Mac, roomId: Id.nullable() })

export const RoomSegment = z.object({
  /** null = home but on an AP without a room. */
  roomId: Id.nullable(),
  apMac: Mac.nullable(),
  start: Ts,
  end: Ts.nullable(),
})

/** GET /api/presence/rooms?from=&to= */
export const RoomTimeline = z.object({
  from: Ts,
  to: Ts,
  rooms: z.array(Room),
  people: z.array(z.object({
    personId: Id,
    current: z.object({ roomId: Id.nullable(), apMac: Mac.nullable(), since: Ts }).nullable(),
    segments: z.array(RoomSegment),
  })),
})

export const RoamEvent = z.object({
  ts: Ts,
  mac: Mac,
  fromApMac: Mac.nullable(),
  fromApName: z.string().nullable(),
  toApMac: Mac.nullable(),
  toApName: z.string().nullable(),
  fromSignal: z.number().nullable(),
  toSignal: z.number().nullable(),
  band: z.string().nullable(),
  channel: z.number().int().nullable(),
  source: z.enum(['ws', 'poll']),
})

/** GET /api/clients/:mac/roams?from=&to= */
export const ClientRoams = z.object({
  mac: Mac,
  from: Ts,
  to: Ts,
  events: z.array(RoamEvent),
  /** Time spent per AP in the range. */
  apDwell: z.array(z.object({ apMac: Mac, apName: z.string(), minutes: z.number() })),
  /** Signal samples (1-min) for a sparkline. */
  signal: z.array(z.object({ ts: Ts, dbm: z.number().nullable(), apMac: Mac.nullable() })),
})

export const StickyClient = z.object({
  mac: Mac,
  displayName: z.string(),
  personId: Id.nullable(),
  apMac: Mac,
  apName: z.string(),
  signal: z.number(),
  since: Ts,
  /** Other APs broadcasting the same SSID. */
  otherAps: z.number().int(),
  nudges24h: z.number().int(),
  lastNudgeAt: Ts.nullable(),
  status: z.enum(['sticky', 'nudged', 'recovered']),
})

/* ───────────────────────────── Incidents ───────────────────────────── */

export const IncidentSeverity = z.enum(['warning', 'critical'])

export const IncidentSignalKind = z.enum([
  'egress_down',
  'egress_up',
  'wan_down',
  'wan_up',
  'device_offline',
  'device_online',
  'device_rebooted',
  'uplink_down',
  'uplink_up',
  'port_issue',
  'mass_disconnect',
  'clients_returned',
  'config_change',
])

export const IncidentRef = z.object({
  type: z.enum(['egress', 'device', 'port', 'client', 'audit']),
  /** egressId | device MAC | "<switchMac>:<idx>" | client MAC | audit event id */
  id: z.string(),
  label: z.string(),
})

export const IncidentSignal = z.object({
  id: Id,
  ts: Ts,
  kind: IncidentSignalKind,
  severity: z.enum(['info', 'warning', 'error']),
  ref: IncidentRef.nullable(),
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.string()),
  /** A config change shortly before the incident started (possible cause). */
  suspect: z.boolean(),
})

export const Incident = z.object({
  id: Id,
  openedAt: Ts,
  resolvedAt: Ts.nullable(),
  status: z.enum(['open', 'resolved']),
  severity: IncidentSeverity,
  /** One-line root-cause sentence, e.g. incident.title.device_offline {name, devices, clients}. */
  titleKey: z.string(),
  titleParams: z.record(z.string(), z.string()),
  root: z.object({ kind: IncidentSignalKind, ref: IncidentRef.nullable() }).nullable(),
  impact: z.object({
    devices: z.array(Mac),
    clients: z.number().int(),
    people: z.array(Id),
    egresses: z.array(Id),
  }),
  signalCount: z.number().int(),
  suspectCount: z.number().int(),
  acknowledged: z.boolean(),
  note: z.string().nullable(),
})

export const IncidentDetail = Incident.extend({
  signals: z.array(IncidentSignal),
  /** Topology node ids affected (for highlighting a mini topology). */
  affectedNodes: z.array(z.string()),
  /** Snapshot pair bracketing the incident start, for "what changed before" diff links. */
  diff: z.object({ fromSnapshotId: Id, toSnapshotId: Id.nullable() }).nullable(),
})

export const IncidentQuery = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const IncidentUpdateInput = z.object({
  acknowledged: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
})

/* ───────────────────────────── Types ───────────────────────────── */

export type DeviceTypeT = z.infer<typeof DeviceType>
export type DeviceStateT = z.infer<typeof DeviceState>
export type DeviceIssueT = z.infer<typeof DeviceIssue>
export type DeviceUplinkT = z.infer<typeof DeviceUplink>
export type InfraDeviceT = z.infer<typeof InfraDevice>
export type InfraDeviceDetailT = z.infer<typeof InfraDeviceDetail>
export type RadioT = z.infer<typeof Radio>
export type PortMediaT = z.infer<typeof PortMedia>
export type PortIssueKindT = z.infer<typeof PortIssueKind>
export type PoeSafetyReasonT = z.infer<typeof PoeSafetyReason>
export type PortPeerT = z.infer<typeof PortPeer>
export type PortViewT = z.infer<typeof PortView>
export type PortEventT = z.infer<typeof PortEvent>
export type PortDetailT = z.infer<typeof PortDetail>
export type PortSeriesPointT = z.infer<typeof PortSeriesPoint>
export type SeriesRangeT = z.infer<typeof SeriesRange>
export type DeviceTransitionT = z.infer<typeof DeviceTransition>
export type FirmwareChangeT = z.infer<typeof FirmwareChange>
export type DeviceSeriesT = z.infer<typeof DeviceSeries>
export type DeviceSeriesPointT = z.infer<typeof DeviceSeriesPoint>
export type DeviceEventsT = z.infer<typeof DeviceEvents>
export type PoeScheduleT = z.infer<typeof PoeSchedule>
export type PoeScheduleInputT = z.input<typeof PoeScheduleInput>
export type PoeScheduleStatusT = z.infer<typeof PoeScheduleStatus>
export type PoeOverrideT = z.infer<typeof PoeOverride>
export type PoeOverrideInputT = z.input<typeof PoeOverrideInput>
export type PoeQualificationT = z.infer<typeof PoeQualification>
export type PoeOverviewT = z.infer<typeof PoeOverview>
export type EnergyPeriodT = z.infer<typeof EnergyPeriod>
export type EnergyReportT = z.infer<typeof EnergyReport>
export type BottleneckKindT = z.infer<typeof BottleneckKind>
export type TopologyClientT = z.infer<typeof TopologyClient>
export type TopologyNodeT = z.infer<typeof TopologyNode>
export type TopologyEdgeT = z.infer<typeof TopologyEdge>
export type TopologyT = z.infer<typeof Topology>
export type RoomT = z.infer<typeof Room>
export type RoomInputT = z.input<typeof RoomInput>
export type RoomSegmentT = z.infer<typeof RoomSegment>
export type RoomTimelineT = z.infer<typeof RoomTimeline>
export type RoamEventT = z.infer<typeof RoamEvent>
export type ClientRoamsT = z.infer<typeof ClientRoams>
export type StickyClientT = z.infer<typeof StickyClient>
export type IncidentSeverityT = z.infer<typeof IncidentSeverity>
export type IncidentSignalKindT = z.infer<typeof IncidentSignalKind>
export type IncidentRefT = z.infer<typeof IncidentRef>
export type IncidentSignalT = z.infer<typeof IncidentSignal>
export type IncidentT = z.infer<typeof Incident>
export type IncidentDetailT = z.infer<typeof IncidentDetail>
