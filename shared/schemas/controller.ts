import { z } from 'zod'
import { Mac, Ts } from './common'

export const VerifyMode = z.enum(['fingerprint', 'ca', 'insecure'])

/** PUT /api/controller and POST /api/setup/controller/test body. */
export const ControllerInput = z.object({
  url: z.string().url(), // e.g. https://192.168.30.1
  username: z.string().min(1),
  /** Omit on update to keep the stored password. */
  password: z.string().min(1).optional(),
  site: z.string().min(1).default('default'),
  verifyMode: VerifyMode.default('fingerprint'),
  /** SHA-256 fingerprint "AB:CD:…" the user confirmed (TOFU). */
  fingerprint: z.string().optional(),
  caPem: z.string().optional(),
})

/** Result of POST /api/setup/controller/inspect — TLS info before trusting. */
export const CertificateInfo = z.object({
  fingerprint: z.string(),
  subject: z.string(),
  issuer: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  selfSigned: z.boolean(),
  altNames: z.array(z.string()),
})

export const CapabilityKey = z.enum([
  'auth',
  'sysinfo',
  'networkconf',
  'routes.read',
  'routes.update',
  'routes.create',
  'routes.delete',
  'objects.read',
  'clients.active',
  'clients.known',
  'devices',
  'websocket',
  'stats.series',
  'systemlog',
  'wlanconf',
  'stamgr',
  'devmgr.powercycle',
  'speedtest',
])

export const CapabilityStatus = z.enum(['ok', 'fail', 'unknown', 'skipped'])

export const Capability = z.object({
  key: CapabilityKey,
  status: CapabilityStatus,
  detail: z.string().nullable(),
  checkedAt: Ts.nullable(),
})

export const ControllerMode = z.enum(['dry-run', 'live'])

export const ControllerStatus = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  mock: z.boolean(),
  url: z.string().nullable(),
  site: z.string().nullable(),
  username: z.string().nullable(),
  verifyMode: VerifyMode.nullable(),
  fingerprint: z.string().nullable(),
  /** Network application version, e.g. "11.0.99". */
  networkVersion: z.string().nullable(),
  /** UniFi OS console version, e.g. "6.0.17". */
  consoleVersion: z.string().nullable(),
  model: z.string().nullable(), // "Dream Machine Pro"
  timezone: z.string().nullable(),
  mode: ControllerMode,
  /** The MAC/IP of the host Unifire runs on, as seen by UniFi (auto-detected or overridden). */
  selfMac: Mac.nullable(),
  selfIp: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSyncAt: Ts.nullable(),
  wsConnected: z.boolean(),
  capabilities: z.array(Capability),
})

export const ModeInput = z.object({ mode: ControllerMode })

export type ControllerInputT = z.infer<typeof ControllerInput>
export type ControllerStatusT = z.infer<typeof ControllerStatus>
export type CapabilityT = z.infer<typeof Capability>
export type CapabilityKeyT = z.infer<typeof CapabilityKey>
export type CertificateInfoT = z.infer<typeof CertificateInfo>
export type ControllerModeT = z.infer<typeof ControllerMode>
