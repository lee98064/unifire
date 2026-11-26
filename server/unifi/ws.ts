import { EventEmitter } from 'node:events'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import WebSocket from 'ws'
import { z } from 'zod'
import type { PortEvent } from '#shared/schemas/infra'
import type { SnapshotResourceT } from '#shared/schemas/insight'
import type { UnifiTransport } from './client'
import { Doc, MacAddress, type WireDoc } from './endpoints/schemas'
import { UnifiError } from './errors'

export type InfraEvent =
  | { type: 'infra.offline', mac: string }
  | { type: 'infra.online', mac: string, downSec: number }
  | { type: 'infra.rebooted', mac: string, unexpected: boolean }
  | { type: 'infra.overheat', mac: string, tempC: number }
  | { type: 'infra.temperature', mac: string, tempC: number }
  | { type: 'infra.firmware', mac: string, version: string }

export type ControllerEvent =
  | InfraEvent
  | { type: 'port.issue', switchMac: string, portIdx: number, kind: z.output<typeof PortEvent>['kind'], eventId: string }
  | { type: 'poe.reading', switchMac: string, percent: number }
  | { type: 'notification', event: 'port_issue' | 'poe_schedule', switchMac: string, portIdx: number,
    kind: string, [field: string]: unknown }
  | { type: 'client.connected' | 'client.disconnected' | 'client.roam', mac: string, data: WireDoc, source?: 'poll' }
  | { type: 'client.updated' | 'device.updated' | 'user.updated', mac: string | null, data: WireDoc }
  | { type: 'controller.event', key: string, data: WireDoc }
  | { type: 'config.unifire_write' }
  | { type: 'config.external_change', resource: SnapshotResourceT, itemId: string, label: string }
  | { type: 'cache.changed', resource: string }
  | { type: 'cache.clientsPolled', at: number, startedAt: number }
  | { type: 'controller.reconnected' | 'controller.mode' | 'routing.settings' }
  | { type: 'rules.changed', ruleIds: string[] }
  | { type: 'routing.changed', managedRouteId: string }
  | { type: 'egress.healthChanged', egressId: string }
  | { type: 'egress.down' | 'egress.up', egressId: string }
  | { type: 'egress.ip_changed', egressId: string, previousIp: string, ip: string }
  | { type: 'client.new', mac: string, displayName: string }
  | { type: 'person.room_entered' | 'person.room_left', personId: string, roomId: string, room?: string }
  | { type: 'person.arrived' | 'person.left', personId: string, mac: string }
  | { type: 'quota.warning' | 'quota.exceeded', quotaId: string, personId: string | null }
  | { type: 'access.changed' | 'access.clientsChanged' }
  | { type: 'notification', event: 'route_drift', managedRouteId: string }
  | { type: 'notification', event: 'new_device', mac: string, displayName: string }
  | { type: 'notification', event: 'quota_warning' | 'quota_exceeded', quotaId: string, personId: string | null }
  | { type: 'notification', event: 'extension_request', requestId: string, personId: string,
    variant?: 'extension_decided', minutes?: number, status?: string }
  | { type: 'notification', event: 'route_switch', managedRouteId: string, route: string, from: string, to: string, reason: string }
  | { type: 'notification', event: 'controller_error', error: string }

export type EngineEvents = EventEmitter<{ event: [ControllerEvent] }>

const message = z.object({ meta: z.object({ message: z.string() }), data: z.array(z.unknown()) })
const clientEvents = new Map<string, 'client.connected' | 'client.disconnected' | 'client.roam'>([
  ['EVT_WU_Connected', 'client.connected'], ['EVT_LU_Connected', 'client.connected'],
  ['EVT_WU_Disconnected', 'client.disconnected'], ['EVT_LU_Disconnected', 'client.disconnected'],
  ['EVT_WU_Roam', 'client.roam'], ['EVT_WU_RoamRadio', 'client.roam'],
])

export function parseControllerEvents(raw: string): ControllerEvent[] {
  try {
    const parsed = message.safeParse(JSON.parse(raw))
    if (!parsed.success) return []
    const kind = parsed.data.meta.message
    return parsed.data.data.flatMap((item): ControllerEvent[] => {
      const data = Doc.safeParse(item).data
      if (!data) return []
      const mac = MacAddress.safeParse(data.mac ?? data.user ?? data.sta).data ?? null
      if (kind === 'events' && typeof data.key === 'string') {
        const type = clientEvents.get(data.key)
        return [type && mac ? { type, mac, data } : { type: 'controller.event', key: data.key, data }]
      }
      if (/^(?:networkconf|wlanconf|trafficroutes?|portforward|firewall|static-dns|object)(?::|$)/i.test(kind)) {
        return [{ type: 'controller.event', key: kind, data }]
      }
      if (kind === 'sta:sync') return [{ type: 'client.updated', mac, data }]
      if (kind === 'device:sync') return [{ type: 'device.updated', mac, data }]
      if (kind.startsWith('user:')) return [{ type: 'user.updated', mac, data }]
      return []
    })
  } catch {
    return []
  }
}

async function upgrade(transport: UnifiTransport, cookie: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new UnifiError('UNIFI_INACTIVE')
  const url = new URL(transport.paths.events, transport.origin)
  const secure = url.protocol === 'https:'
  url.protocol = secure ? 'wss:' : 'ws:'
  const agent = secure ? new HttpsAgent() : new HttpAgent()
  agent.createConnection = (_options, callback) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    transport.connect({
      hostname, protocol: secure ? 'https:' : 'http:', port: url.port || (secure ? '443' : '80'),
    }, (error, socket) => {
      // Node's Agent ignores the socket argument when an error is provided.
      if (error) callback?.(error, null!)
      else if (socket) callback?.(null, socket)
    })
    return undefined
  }

  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { agent, headers: { cookie }, handshakeTimeout: 6000, maxPayload: 4 * 1024 * 1024 })
    const abort = () => ws.terminate()
    signal?.addEventListener('abort', abort, { once: true })
    ws.on('error', error => reject(error instanceof UnifiError ? error : new UnifiError('UNIFI_WEBSOCKET', undefined, { cause: error })))
    ws.once('close', () => {
      signal?.removeEventListener('abort', abort)
      agent.destroy()
      reject(new UnifiError('UNIFI_WEBSOCKET'))
    })
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode
      const code = status === 401 ? 'UNIFI_AUTH_REQUIRED'
        : response.headers['content-type']?.includes('text/html') ? 'UNIFI_HTML'
        : status === 404 ? 'UNIFI_NOT_FOUND'
        : status === 403 ? 'UNIFI_FORBIDDEN'
        : status === 429 ? 'UNIFI_RATE_LIMITED' : 'UNIFI_WEBSOCKET'
      reject(new UnifiError(code, status))
      response.destroy()
      ws.terminate()
    })
    ws.once('open', () => resolve(ws))
  })
}

async function openEvents(transport: UnifiTransport, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const session = await transport.wsSession()
    try {
      const ws = await upgrade(transport, session.cookie, signal)
      transport.confirm(session.generation)
      return { ws, generation: session.generation }
    } catch (error) {
      if (!(error instanceof UnifiError) || error.status !== 401) throw error
      transport.invalidate(session.generation, attempt > 0)
      if (attempt > 0) throw error
    }
  }
}

export async function checkWebSocket(transport: UnifiTransport) {
  const { ws } = await openEvents(transport)
  ws.terminate()
}

export function startEvents(transport: UnifiTransport, engine: EngineEvents, onConnected: (value: boolean) => void) {
  const abort = new AbortController()
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule() {
    if (abort.signal.aborted) return
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(retries++, 6))
    timer = setTimeout(() => { void connect() }, delay * (0.75 + Math.random() * 0.5))
    timer.unref()
  }

  async function connect() {
    try {
      const { ws, generation } = await openEvents(transport, abort.signal)
      if (abort.signal.aborted) return ws.terminate()
      let alive = true
      const started = Date.now()
      const heartbeat = setInterval(() => {
        if (!alive) return ws.terminate()
        alive = false
        ws.ping()
      }, 30_000)
      heartbeat.unref()
      ws.on('pong', () => { alive = true })
      ws.on('message', raw => {
        for (const event of parseControllerEvents(raw.toString())) engine.emit('event', event)
      })
      ws.once('close', (code) => {
        clearInterval(heartbeat)
        if (code === 4001 || code === 4401) transport.invalidate(generation)
        if (Date.now() - started >= 30_000) retries = 0
        onConnected(false)
        schedule()
      })
      onConnected(true)
      engine.emit('event', { type: 'controller.reconnected' })
    } catch {
      schedule()
    }
  }

  void connect()
  return () => {
    abort.abort()
    clearTimeout(timer)
  }
}
