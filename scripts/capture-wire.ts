import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'
import WebSocket from 'ws'
import { z } from 'zod'
import { createUnifiTransport, type UnifiConfig, type UnifiTransport } from '../server/unifi/client'
import { UnifiError } from '../server/unifi/errors'
import { segment } from '../server/unifi/paths'
import { poeCapable } from '../server/unifi/poe-ports'
import { createCrypto } from '../server/utils/crypto'
import { loadEncryptionKey } from '../server/utils/keys'
import { ControllerInput } from '../shared/schemas/controller'
import { createDeidentifier, normalizeMac } from './capture-deidentify'

type Doc = Record<string, unknown>
const doc = z.looseObject({})
const classicResources = [
  'stat/sysinfo', 'stat/health', 'stat/device', 'stat/device-basic',
  'rest/device', 'rest/portconf', 'rest/wlanconf', 'stat/sta',
] as const
const activeClients = 'clients/active?includeTrafficUsage=true&includeUnifiDevices=true'
const v2Resources = [activeClients, 'device', 'devices'] as const
const savedController = ControllerInput.omit({ password: true }).extend({
  site: ControllerInput.shape.site.unwrap(),
  verifyMode: ControllerInput.shape.verifyMode.unwrap(),
  fingerprint: z.string().nullable(),
  caPem: z.string().nullable(),
  encryptedPassword: z.string(),
  networkVersion: z.string().nullable(),
})

class CaptureError extends Error {}

function readConfig(dataDir: string) {
  let saved: z.infer<typeof savedController>
  try {
    const db = new Database(join(dataDir, 'unifire.db'), { readonly: true, fileMustExist: true })
    try {
      const row = db.prepare(`SELECT url, username, site, verify_mode AS verifyMode, fingerprint, ca_pem AS caPem,
        encrypted_password AS encryptedPassword, network_version AS networkVersion FROM controller WHERE id = 1`).get()
      saved = savedController.parse(row)
    } finally {
      db.close()
    }
  } catch {
    throw new CaptureError('Could not read the saved controller configuration from unifire.db.')
  }

  try {
    const secret = process.env.UNIFIRE_SECRET || process.env.NUXT_UNIFIRE_SECRET
    const key = secret ? loadEncryptionKey(dataDir, secret) : readKeyFile(join(dataDir, 'secret.key'))
    const password = z.string().min(1).parse(createCrypto(key).decrypt(saved.encryptedPassword))
    const config: UnifiConfig = {
      url: saved.url, username: saved.username, site: saved.site, verifyMode: saved.verifyMode, password,
      fingerprint: saved.fingerprint ?? undefined, caPem: saved.caPem ?? undefined,
    }
    return { config, networkVersion: saved.networkVersion }
  } catch {
    throw new CaptureError('Could not decrypt the controller password using the Unifire secret.')
  }
}

function readKeyFile(path: string) {
  // The app's file loader can create or chmod the key. This collector only reads it.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Expected a regular key file')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function readOnlyTransport(transport: UnifiTransport) {
  const allowed = new Set([
    ...classicResources.map(resource => transport.paths.classic(resource)),
    ...v2Resources.map(resource => transport.paths.v2(resource)),
  ])
  const detailsPrefix = transport.paths.classic('stat/device/')
  return {
    request(method: string, path: string) {
      const deviceDetail = path.startsWith(detailsPrefix) && /^([\da-f]{2}%3A){5}[\da-f]{2}$/i.test(path.slice(detailsPrefix.length))
      // The shared client generates its own login POST. This wrapper exposes no POST or write method.
      if (method !== 'GET' || (!allowed.has(path) && !deviceDetail)) {
        throw new UnifiError('UNIFI_CAPTURE_READ_ONLY')
      }
      return transport.read(path)
    },
    paths: transport.paths,
    events: (seconds: number, deidentifier: ReturnType<typeof createDeidentifier>) => captureEvents(transport, seconds, deidentifier),
  }
}

function failure(error: unknown) {
  return error instanceof UnifiError
    ? { ok: false as const, status: error.status ?? null, error: error.code }
    : { ok: false as const, status: null, error: 'UNIFI_CAPTURE_FAILED' }
}

function docs(data: unknown): Doc[] {
  return Array.isArray(data) ? data.flatMap(value => {
    const row = doc.safeParse(value).data
    return row ? [row] : []
  }) : []
}

function projectRows(value: unknown, project: (rows: Doc[]) => Doc[]) {
  if (Array.isArray(value)) return project(docs(value))
  const container = doc.safeParse(value).data
  if (Array.isArray(container?.data)) return { ...container, data: project(docs(container.data)) }
  throw new UnifiError('UNIFI_INVALID_RESPONSE')
}

function isWired(row: Doc) {
  const wired = row.is_wired ?? row.isWired ?? row.wired
  if (typeof wired === 'boolean') return wired
  const type = typeof row.connectionType === 'string' ? row.connectionType.toLowerCase() : ''
  if (['wired', 'ethernet'].includes(type)) return true
  if (['wireless', 'wifi', 'wi-fi'].includes(type)) return false
  return Boolean(row.sw_mac ?? row.switchMac)
}

function capClients(rows: Doc[], max: number) {
  let wireless = 0
  let wired = 0
  return rows.filter(row => isWired(row) ? wired++ < max : wireless++ < max)
}

const wlanNamesAndIds = new Set([
  '_id', 'id', 'site_id', 'networkconf_id', 'wlan_id', 'wlangroup_id',
  'name', 'display_name', 'ssid', 'essid',
])
const wlanFlags = new Set(['enabled', 'is_guest', 'hide_ssid', 'is_hidden'])

function projectWlans(rows: Doc[]) {
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key, value]) =>
    typeof value === 'boolean' || key === 'flags' && typeof value === 'number'
    || wlanNamesAndIds.has(key) && (typeof value === 'string' || typeof value === 'number' || value === null)
    || wlanFlags.has(key) && value === null,
  )))
}

const string = (value: unknown) => typeof value === 'string' ? value : null
const number = (value: unknown) => typeof value === 'number' ? value : null

function summarize(device: Doc, deidentifier: ReturnType<typeof createDeidentifier>) {
  const ports = docs(device.port_table)
  const uplink = doc.safeParse(device.uplink).data
  const radios = [...docs(device.radio_table), ...docs(device.radio_table_stats)]
  const mac = normalizeMac(device.mac)
  const uplinkMac = normalizeMac(uplink?.uplink_mac ?? uplink?.mac ?? device.uplink_mac)
  const uplinkType = string(uplink?.type ?? device.uplink_type)
  const radioBands = new Set(radios.flatMap(radio => {
    const band = string(radio.band ?? radio.radio)
    return band ? [deidentifier.string(band)] : []
  }))
  return {
    pseudoMac: mac ? deidentifier.pseudoMac(mac) : null,
    type: string(device.type),
    model: string(device.model),
    version: string(device.version),
    state: number(device.state) ?? deidentifier.value(string(device.state)),
    portCount: Array.isArray(device.port_table) ? ports.length : number(device.num_ports) ?? 0,
    poePorts: ports.filter(poeCapable).length,
    sfpPorts: ports.filter(port => port.is_sfp === true || port.sfp === true ||
      [port.media, port.port_type, port.type, port.name].some(value => typeof value === 'string' && /\bsfp/i.test(value))).length,
    uplinkType,
    uplinkPseudoMac: uplinkMac ? deidentifier.pseudoMac(uplinkMac) : null,
    radioBands: [...radioBands],
    numSta: number(device.num_sta),
  }
}

type Kind = { count: number, samples: unknown[] }
type WsCapture = { seconds: number, kinds: Record<string, Kind & { eventKeys?: Record<string, Kind> }> }

const frameSchema = z.looseObject({ meta: z.looseObject({ message: z.string() }), data: z.array(z.unknown()) })

function collectFrames(deidentifier: ReturnType<typeof createDeidentifier>) {
  const messages = new Map<string, Kind>()
  const eventKeys = new Map<string, Kind>()

  function add(buckets: Map<string, Kind>, key: string, sample: unknown) {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { count: 0, samples: [] }
      buckets.set(key, bucket)
    }
    bucket.count++
    if (bucket.samples.length < 3) bucket.samples.push(deidentifier.value(sample))
  }

  return {
    receive(raw: WebSocket.RawData) {
      try {
        const frame = frameSchema.safeParse(JSON.parse(raw.toString())).data
        if (!frame) return
        const kind = frame.meta.message
        add(messages, deidentifier.kind(kind, 'message'), frame)
        if (kind === 'events') {
          for (const row of docs(frame.data)) {
            if (typeof row.key === 'string') add(eventKeys, deidentifier.kind(row.key, 'event'), row)
          }
        }
      } catch {
        // Leave malformed frames out of the capture without logging their contents.
      }
    },
    kinds() {
      const kinds: WsCapture['kinds'] = Object.fromEntries(messages)
      if (kinds.events) kinds.events = { ...kinds.events, eventKeys: Object.fromEntries(eventKeys) }
      return kinds
    },
  }
}

function subscribe(transport: UnifiTransport, session: Awaited<ReturnType<UnifiTransport['wsSession']>>,
  seconds: number, receive: (raw: WebSocket.RawData) => void) {
  const url = new URL(transport.paths.events, transport.origin)
  const secure = url.protocol === 'https:'
  const agent = secure ? new HttpsAgent() : new HttpAgent()
  agent.createConnection = (_options, callback) => {
    transport.connect({
      hostname: url.hostname.replace(/^\[|\]$/g, ''), protocol: url.protocol, port: url.port || (secure ? '443' : '80'),
    }, (error, socket) => {
      if (error) callback?.(error, null!)
      else if (socket) callback?.(null, socket)
    })
    return undefined
  }
  const wsUrl = new URL(url)
  wsUrl.protocol = secure ? 'wss:' : 'ws:'

  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      agent, headers: { cookie: session.cookie }, handshakeTimeout: 6000, maxPayload: 4 * 1024 * 1024,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let error: UnifiError | undefined
    let finished = false
    socket.on('message', receive)
    socket.on('error', cause => { error ??= cause instanceof UnifiError ? cause : new UnifiError('UNIFI_WEBSOCKET') })
    socket.once('unexpected-response', (_request, response) => {
      error = new UnifiError('UNIFI_WEBSOCKET', response.statusCode)
      response.destroy()
      socket.terminate()
    })
    socket.once('open', () => {
      transport.confirm(session.generation)
      heartbeat = setInterval(() => socket.ping(), 30_000)
      timer = setTimeout(() => {
        finished = true
        socket.terminate()
      }, seconds * 1000)
    })
    socket.once('close', () => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      agent.destroy()
      if (finished && !error) resolve()
      else reject(error ?? new UnifiError('UNIFI_WEBSOCKET_CLOSED'))
    })
  })
}

async function captureEvents(transport: UnifiTransport, seconds: number, deidentifier: ReturnType<typeof createDeidentifier>) {
  const frames = collectFrames(deidentifier)
  try {
    if (seconds > 0) {
      for (let attempt = 0; ; attempt++) {
        const session = await transport.wsSession()
        try {
          await subscribe(transport, session, seconds, frames.receive)
          break
        } catch (error) {
          if (!(error instanceof UnifiError) || error.status !== 401) throw error
          transport.invalidate(session.generation, attempt > 0)
          if (attempt > 0) throw error
        }
      }
    }
    return { seconds, kinds: frames.kinds() }
  } catch (error) {
    return { seconds, kinds: frames.kinds(), ...failure(error) }
  }
}

export async function captureWire(transport: UnifiTransport, options: {
  site: string, networkVersion: string | null, seconds: number, maxClients: number,
}) {
  const capturedAt = Date.now()
  const deidentifier = createDeidentifier()
  const readOnly = readOnlyTransport(transport)
  const resources: Record<string, { ok: true, data: unknown } | ReturnType<typeof failure>> = {}

  async function capture(key: string, path: string, project: (value: unknown) => unknown = value => value) {
    try {
      const raw = await readOnly.request('GET', path)
      resources[key] = { ok: true, data: deidentifier.value(project(raw)) }
      return raw
    } catch (error) {
      resources[key] = failure(error)
      return null
    }
  }

  const classic = new Map<string, unknown>()
  for (const resource of classicResources) {
    const project = resource === 'rest/wlanconf' ? (value: unknown) => projectRows(value, projectWlans)
      : resource === 'stat/sta' ? (value: unknown) => projectRows(value, rows => capClients(rows, options.maxClients))
      : undefined
    classic.set(resource, await capture(resource, readOnly.paths.classic(resource), project))
  }

  const full = docs(classic.get('stat/device'))
  const basic = docs(classic.get('stat/device-basic'))
  const config = docs(classic.get('rest/device'))
  const devices = full.length ? full : basic.length ? basic : config
  const sampledTypes = new Set<string>()
  for (const device of [...devices, ...basic, ...config]) {
    const mac = normalizeMac(device.mac)
    const type = string(device.type)
    if (!mac || !type || sampledTypes.has(type)) continue
    sampledTypes.add(type)
    await capture(`stat/device/${deidentifier.pseudoMac(mac)}`, readOnly.paths.classic(`stat/device/${segment(mac)}`))
  }

  for (const resource of v2Resources) {
    const project = resource === activeClients ? (value: unknown) => projectRows(value, rows => capClients(rows, options.maxClients)) : undefined
    await capture(`v2/${resource}`, readOnly.paths.v2(resource), project)
  }

  const sysinfo = classic.get('stat/sysinfo')
  const version = docs(sysinfo)[0]?.version ?? doc.safeParse(sysinfo).data?.version
  return {
    capturedAt,
    networkVersion: string(version) ?? options.networkVersion,
    site: deidentifier.string(options.site, 'site'),
    summary: devices.map(device => summarize(device, deidentifier)),
    resources,
    ws: await readOnly.events(options.seconds, deidentifier),
  }
}

function integerOption(value: string, name: string, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw new CaptureError(`${name} must be a whole number between 0 and ${max}.`)
  }
  return number
}

const usage = 'Usage: pnpm tsx scripts/capture-wire.ts (--data-dir DIR | --mock) --out FILE [--ws-seconds 180] [--max-clients 15]'

async function main() {
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string' }, out: { type: 'string' }, 'ws-seconds': { type: 'string', default: '180' },
    'max-clients': { type: 'string', default: '15' }, mock: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) return console.log(usage)
  if (!values.out || Boolean(values['data-dir']) === Boolean(values.mock)) throw new CaptureError(usage)
  const seconds = integerOption(values['ws-seconds'], '--ws-seconds', Math.floor(0x7fffffff / 1000))
  const maxClients = integerOption(values['max-clients'], '--max-clients')
  const mock = values.mock ? await (await import('../server/unifi/mock/index')).startMockController({ lively: true }) : undefined
  try {
    const { config, networkVersion } = mock ? { config: mock.config, networkVersion: null } : readConfig(values['data-dir']!)
    const transport = createUnifiTransport(config, { mock: Boolean(mock) })
    try {
      const result = await captureWire(transport, { site: config.site, networkVersion, seconds, maxClients })
      const json = `${JSON.stringify(result, null, 2)}\n`
      try {
        const fd = openSync(values.out, 'wx', 0o600)
        try {
          fchmodSync(fd, 0o600)
          writeFileSync(fd, json)
        } finally {
          closeSync(fd)
        }
      } catch {
        throw new CaptureError('Could not write the capture. Use a new output file in a writable directory.')
      }
      console.table(result.summary.map(device => ({ ...device, radioBands: device.radioBands.join(', ') })))
    } finally {
      await transport.close()
    }
  } finally {
    await mock?.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof CaptureError ? error.message : error instanceof UnifiError ? error.code : usage)
    process.exitCode = 1
  })
}
