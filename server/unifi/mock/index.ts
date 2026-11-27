import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createSecureServer, type ServerOptions } from 'node:https'
import { WebSocket, WebSocketServer } from 'ws'
import { Doc, Docs, Route, Station, type WireDoc } from '../endpoints/schemas'
import { osPaths } from '../paths'
import { createMockFleet, type MockBootTimes } from './infra'
import { buildFixtures, createRandom, DEMO_ROUTES, MOCK_PASSWORD, MOCK_SITE, MOCK_USERNAME, probeProfiles, SELF_MAC } from './fixtures'

type Failure = 'html' | '401' | 'loginRequired' | '403' | '404' | '429'
type Outage = { start: number, end: number }

async function readBody(request: IncomingMessage) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('Body too large')
    chunks.push(buffer)
  }
  return Doc.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

const classic = (data: unknown = []) => ({ meta: { rc: 'ok' }, data })

export async function startMockController(options: {
  seed?: number
  guestWlan?: { id: string, passphrase: string }
  lively?: boolean
  sessionTtlMs?: number
  tls?: ServerOptions
  now?: () => number
  bootTimes?: MockBootTimes
} = {}) {
  const now = options.now ?? Date.now
  const started = now()
  const random = createRandom(options.seed ?? 903)
  const paths = osPaths(MOCK_SITE)
  const fixtures = buildFixtures(started, '127.0.0.1')
  const networks = fixtures.networks
  const routes = new Map(fixtures.routes.map(raw => { const route = Route.parse(raw); return [route._id, route] }))
  const clients = new Map(fixtures.clients.map(raw => [raw.mac, { ...Station.parse(raw), online: raw.online }]))
  const wlans = new Map(fixtures.wlans.map(wlan => [wlan._id, Doc.parse(wlan)]))
  const savedWlan = options.guestWlan && wlans.get(options.guestWlan.id)
  if (savedWlan && options.guestWlan) savedWlan.x_passphrase = options.guestWlan.passphrase
  const fleet = createMockFleet(clients, now, createRandom((options.seed ?? 903) + 1), options.bootTimes)
  const { devices } = fleet
  const portForwards = new Map<string, WireDoc>([['demo-forward', { _id: 'demo-forward', name: 'Demo port forward',
    enabled: true, src: 'any', dst_port: '8443', fwd: '10.235.0.25', fwd_port: '443', proto: 'tcp' }]])
  const staticDns = new Map<string, WireDoc>([['demo-dns', { _id: 'demo-dns',
    key: 'nas.example.test', value: '10.235.0.25', record_type: 'A', enabled: true }]])
  const firewallPolicies = new Map<string, WireDoc>([['demo-policy', { _id: 'demo-policy', name: 'Demo isolation',
    enabled: true, index: 10000, action: 'BLOCK', source: { zone_id: 'demo-zone-core' }, predefined: false }]])
  const objects = new Map<string, WireDoc>(Array.from({ length: 3 }, (_, index) => {
    const id = `demo-object-${index}`
    return [id, { id, name: `Demo object ${index + 1}`, enabled: true, target_type: 'CLIENT', targets: [],
      route: { enabled: true, network_id: 'demo-wan-1' } }]
  }))
  const wss = new WebSocketServer({ noServer: true })
  const sessions = new Map<string, { csrf: string, until: number }>()
  const profiles = probeProfiles()
  const outages = new Map<string, Outage[]>()
  const failures = new Map<string, Failure[]>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let logins = 0
  let mutations = 0
  let unfamiliarIndex = 0
  let speedtestAt: number | null = null
  let simulatedTicks = 0
  let externalRotation = 0
  const log: Record<string, unknown>[] = []

  function emit(message: string, data: unknown[]) {
    const payload = JSON.stringify({ meta: { rc: 'ok', message }, data })
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }

  function event(key: string, mac: string) {
    const row = { key, user: mac, time: now() }
    log.unshift(row)
    if (log.length > 250) log.pop()
    emit('events', [row])
  }

  function setOnline(mac: string, active: boolean) {
    const client = clients.get(mac)
    if (!client || client.online === active) return
    client.online = active
    client.last_seen = Math.floor(now() / 1000)
    const prefix = client.is_wired ? 'LU' : 'WU'
    event(`EVT_${prefix}_${active ? 'Connected' : 'Disconnected'}`, mac)
  }

  function togglePortForward() {
    const rule = portForwards.get('demo-forward')
    if (!rule) return
    rule.enabled = !rule.enabled
    event('EVT_PortForwardUpdated', SELF_MAC)
  }

  function tick() {
    for (const client of clients.values()) {
      if (!client.online || client.blocked) continue
      const rx = Math.floor(random() * 25_000)
      const tx = Math.floor(rx / 5)
      client.rx_bytes = (client.rx_bytes ?? 0) + rx
      client.tx_bytes = (client.tx_bytes ?? 0) + tx
      client['rx_bytes-r'] = Math.floor(rx / 10)
      client['tx_bytes-r'] = Math.floor(tx / 10)
      client.last_seen = Math.floor(now() / 1000)
    }
    emit('device:sync', devices)
    simulatedTicks++
    if (simulatedTicks % 9 === 0) togglePortForward()
    const rotation = Math.floor((now() - started) / 300_000)
    if (rotation > externalRotation) {
      const route = routes.get(DEMO_ROUTES.external)!
      const ids = ['demo-wan-1', 'demo-vpn-1', 'demo-vpn-2', 'demo-vpn-3']
      routes.set(route._id, { ...route, network_id: ids[rotation % ids.length]! })
      externalRotation = rotation
      event('EVT_RouteUpdated', SELF_MAC)
    }
    const candidates = [...clients.values()].filter(client => client.mac !== SELF_MAC && client.hostname !== 'alder-phone' && !client.blocked)
    const client = candidates[Math.floor(random() * candidates.length)]
    if (client && simulatedTicks % 2 === 0) setOnline(client.mac, !client.online)
    if (simulatedTicks % 18 === 0) {
      const index = ++unfamiliarIndex
      const suffix = (index % 65536).toString(16).padStart(4, '0')
      const mac = `02:25:31:00:${suffix.slice(0, 2)}:${suffix.slice(2)}`
      clients.set(mac, { mac, _id: `demo-visitor-${index}`, hostname: `lab-visitor-${index}`,
        ip: `10.235.2.${100 + index % 100}`, blocked: false, online: false,
        network_id: 'demo-lan-2', essid: 'Guest', first_seen: Math.floor(now() / 1000) })
      emit('user:add', [clients.get(mac)])
      setOnline(mac, true)
    }
  }

  function later(task: () => void, ms: number) {
    const timer = setTimeout(() => { timers.delete(timer); task() }, ms)
    timers.add(timer)
    timer.unref()
  }

  function activeSession(req: IncomingMessage) {
    const token = req.headers.cookie?.match(/(?:^|;\s*)TOKEN=([^;]+)/)?.[1]
    if (!token) return
    const session = sessions.get(token)
    if (session && session.until <= now()) {
      sessions.delete(token)
      return
    }
    return session
  }

  function failure(res: ServerResponse, value: Failure) {
    if (value === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><title>Network is starting</title>')
    }
    if (value === 'loginRequired') return json(res, { meta: { rc: 'error', msg: 'api.err.LoginRequired' } })
    return json(res, { error: Number(value) }, Number(value))
  }

  function rotate(res: ServerResponse, session: { csrf: string }) {
    mutations++
    session.csrf = randomUUID()
    res.setHeader('X-Updated-Csrf-Token', session.csrf)
  }

  const sysinfo = { version: '11.0.104', console_display_version: '6.0.17', udm_version: '6.0.17',
    name: 'Dream Machine Pro', ubnt_device_type: 'UDMPRO', hostname: 'demo-console', timezone: 'Asia/Taipei' }
  const readClassic = new Map<string, () => unknown>([
    [paths.sites, () => [{ _id: 'demo-site', name: MOCK_SITE, desc: 'Default' }]],
    [paths.classic('stat/sysinfo'), () => [sysinfo]],
    [paths.classic('rest/networkconf'), () => networks],
    [paths.classic('stat/sta'), () => [...clients.values()].filter(fleet.activeClient)],
    [paths.classic('rest/user'), () => [...clients.values()]],
    [paths.classic('stat/alluser'), () => [...clients.values()]],
    [paths.classic('stat/device'), fleet.poll],
    [paths.classic('stat/gateway'), () => devices.slice(0, 1)],
    [paths.classic('stat/health'), () => [{ subsystem: 'wan', status: 'ok' }]],
    [paths.classic('rest/wlanconf'), () => [...wlans.values()]],
    [paths.classic('rest/portforward'), () => [...portForwards.values()]],
    [paths.classic('rest/routing'), () => []],
    [paths.classic('rest/portconf'), () => [{ _id: 'demo-port-poe', name: 'PoE access', poe_mode: 'auto' }]],
  ])
  const readV2 = new Map<string, () => unknown>([
    [paths.v2('trafficroutes'), () => [...routes.values()]],
    [paths.v2('object-oriented-network-configs'), () => [...objects.values()]],
    [paths.v2('clients/active'), () => [...clients.values()].filter(fleet.activeClient).map(client => {
      const { rx_bytes, tx_bytes, ...fields } = client
      return { ...fields, trafficUsage: { rxBytes: rx_bytes, txBytes: tx_bytes } }
    })],
    [paths.v2('firewall/zone'), () => [{ _id: 'demo-zone-core', name: 'Core', default_zone: true, network_ids: ['demo-lan-0'] }]],
    [paths.v2('firewall-policies'), () => [...firewallPolicies.values()]],
    [paths.v2('static-dns'), () => [...staticDns.values()]],
    [paths.v2('qos-rules'), () => []],
    [paths.stats('schemas'), () => ['activityBySiteByClient']],
    [paths.stats('recent/series'), () => ({
      data: [{ ts: Math.floor(now() / 60000) * 60000, values: { rxBytes: 1_260_000, txBytes: 442_500 } }],
    })],
  ])

  const configurable = [
    { collection: paths.v2('object-oriented-network-configs'), items: paths.v2('object-oriented-network-config'),
      docs: objects, key: 'id', classic: false },
    { collection: paths.v2('firewall-policies'), docs: firewallPolicies, key: '_id', classic: false },
    { collection: paths.classic('rest/portforward'), docs: portForwards, key: '_id', classic: true },
    { collection: paths.v2('static-dns'), docs: staticDns, key: '_id', classic: false },
    { collection: paths.classic('rest/wlanconf'), docs: wlans, key: '_id', classic: true },
  ]

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method
    const failureKey = `${method} ${path}`
    const failed = failures.get(failureKey)?.shift()
    if (path === paths.login && method === 'POST') {
      logins++
      if (failed) return failure(res, failed)
      const input = await readBody(req)
      if (input.username !== MOCK_USERNAME || input.password !== MOCK_PASSWORD) return failure(res, '401')
      const token = randomUUID()
      const csrf = randomUUID()
      sessions.set(token, { csrf, until: now() + (options.sessionTtlMs ?? 30 * 60_000) })
      res.setHeader('Set-Cookie', [`TOKEN=${token}; Path=/; HttpOnly`, 'DEMO=1; Path=/'])
      res.setHeader('X-CSRF-Token', csrf)
      return json(res, { user: MOCK_USERNAME })
    }
    if (failed) return failure(res, failed)
    const session = activeSession(req)
    if (!session) return failure(res, '401')
    if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) return failure(res, '403')
    if (method === 'GET') {
      const readC = readClassic.get(path)
      if (readC) return json(res, classic(readC()))
      const readV = readV2.get(path)
      if (readV) return json(res, readV())
      const deviceBase = paths.classic('stat/device') + '/'
      if (path.startsWith(deviceBase)) {
        const mac = decodeURIComponent(path.slice(deviceBase.length))
        return json(res, classic(fleet.poll().filter(device => device.mac === mac)))
      }
    }

    const deviceWriteBase = paths.classic('rest/device') + '/'
    if (method === 'PUT' && path.startsWith(deviceWriteBase)) {
      const id = decodeURIComponent(path.slice(deviceWriteBase.length))
      const body = await readBody(req)
      const device = fleet.setPortOverrides(id, Docs.parse(body.port_overrides))
      if (!device) return failure(res, '404')
      mutations++
      rotate(res, session)
      emit('device:sync', devices)
      return json(res, classic([device]))
    }

    const routeBase = paths.v2('trafficroutes')
    if (path === routeBase && method === 'POST') {
      const id = `demo-route-${randomUUID()}`
      const route = Route.parse({ ...await readBody(req), _id: id })
      routes.set(id, route)
      rotate(res, session)
      return json(res, route)
    }
    if (path.startsWith(`${routeBase}/`)) {
      const id = decodeURIComponent(path.slice(routeBase.length + 1))
      const route = routes.get(id)
      if (!route) return failure(res, '404')
      if (method === 'GET') return json(res, route)
      if (method === 'PUT') {
        routes.set(id, Route.parse({ ...await readBody(req), _id: id }))
        rotate(res, session)
        return json(res, routes.get(id))
      }
      if (method === 'DELETE') {
        routes.delete(id)
        rotate(res, session)
        res.writeHead(204)
        return res.end()
      }
    }
    if (path.startsWith(paths.v2('system-log/')) && method === 'POST') {
      const body = await readBody(req)
      const number = typeof body.pageNumber === 'number' ? body.pageNumber : 0
      const size = typeof body.pageSize === 'number' && body.pageSize > 0 ? body.pageSize : 50
      const entries = log.filter(entry => typeof entry.time === 'number'
        && (typeof body.timestampFrom !== 'number' || entry.time >= body.timestampFrom)
        && (typeof body.timestampTo !== 'number' || entry.time <= body.timestampTo))
      return json(res, { data: entries.slice(number * size, (number + 1) * size),
        page_number: number, total_element_count: entries.length, total_page_count: Math.ceil(entries.length / size) })
    }
    if (path === paths.classic('cmd/stamgr') && method === 'POST') {
      const body = await readBody(req)
      const client = typeof body.mac === 'string' ? clients.get(body.mac) : undefined
      if (!client) return failure(res, '404')
      if (body.cmd === 'block-sta') client.blocked = true
      else if (body.cmd === 'unblock-sta') client.blocked = false
      else if (body.cmd === 'kick-sta') setOnline(client.mac, false)
      else return failure(res, '404')
      emit('user:sync', [client])
      rotate(res, session)
      return json(res, classic())
    }
    if (path === paths.classic('cmd/devmgr') && method === 'POST') {
      const body = await readBody(req)
      if (body.cmd === 'speedtest-status') {
        const finished = speedtestAt !== null && now() >= speedtestAt
        return json(res, classic([{ status: speedtestAt === null ? 'idle' : finished ? 'finished' : 'running',
          ...(finished && { xput_download: 421.8, xput_upload: 96.5, latency: 7, timestamp: speedtestAt, wan_networkgroup: 'WAN' }) }]))
      }
      if (body.cmd === 'speedtest') speedtestAt = now() + 2000
      else if (body.cmd === 'power-cycle') {
        const device = devices.find(item => item.mac === body.mac)
        const port = device?.port_table?.find(item => item.port_idx === body.port_idx && item.port_poe && !item.is_uplink)
        if (!port) return failure(res, '404')
        const wasUp = port.up
        port.up = false
        emit('device:sync', [device])
        later(() => {
          port.up = wasUp
          fleet.reboot(fleet.graph.downstream(String(body.mac), Number(body.port_idx)).map(peer => peer.device.mac))
          emit('device:sync', [device])
        }, 1200)
      } else if (body.cmd === 'restart') {
        const macs = Array.isArray(body.macs) ? body.macs : []
        const targets = devices.filter(item => macs.includes(item.mac))
        if (!targets.length) return failure(res, '404')
        emit('device:sync', targets)
      } else if (body.cmd === 'set-locate' || body.cmd === 'unset-locate') {
        const device = devices.find(item => item.mac === body.mac)
        if (!device) return failure(res, '404')
        device.locating = body.cmd === 'set-locate'
        emit('device:sync', [device])
      } else return failure(res, '404')
      rotate(res, session)
      return json(res, classic())
    }
    for (const config of configurable) {
      const prefix = `${config.items ?? config.collection}/`
      const response = (doc: WireDoc) => config.classic ? classic([doc]) : doc
      if (path === config.collection && method === 'POST') {
        const id = `demo-config-${randomUUID()}`
        const doc = { ...await readBody(req), [config.key]: id }
        config.docs.set(id, doc)
        rotate(res, session)
        return json(res, response(doc))
      }
      if (!path.startsWith(prefix)) continue
      const id = decodeURIComponent(path.slice(prefix.length))
      const doc = config.docs.get(id)
      if (!doc) return failure(res, '404')
      if (method === 'GET') return json(res, response(doc))
      if (method === 'PUT' && config.docs !== staticDns) {
        const next = { ...await readBody(req), [config.key]: id }
        config.docs.set(id, next)
        rotate(res, session)
        return json(res, response(next))
      }
      if (method === 'DELETE') {
        config.docs.delete(id)
        rotate(res, session)
        res.writeHead(204)
        return res.end()
      }
    }
    const userBase = paths.classic('rest/user')
    if (path === userBase && method === 'POST') {
      const client = Station.parse({ ...await readBody(req), _id: `demo-user-${randomUUID()}` })
      if (clients.has(client.mac)) return json(res, { error: 'client already exists' }, 409)
      clients.set(client.mac, { ...client, online: false })
      rotate(res, session)
      return json(res, classic([client]))
    }
    if (path.startsWith(`${userBase}/`)) {
      const id = decodeURIComponent(path.slice(userBase.length + 1))
      const doc = [...clients.values()].find(client => client._id === id)
      if (!doc) return failure(res, '404')
      if (method === 'GET') return json(res, classic([doc]))
      if (method === 'PUT') {
        const client = Station.parse({ ...await readBody(req), _id: id })
        if (client.mac !== doc.mac) return json(res, { error: 'invalid client' }, 400)
        clients.set(client.mac, { ...client, online: doc.online })
        emit('user:sync', [client])
        rotate(res, session)
        return json(res, classic([client]))
      }
      if (method === 'DELETE') {
        clients.delete(doc.mac)
        rotate(res, session)
        return json(res, classic())
      }
    }
    return failure(res, '404')
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, { error: 'invalid request' }, 400)
      else res.destroy()
    })
  }
  const server = options.tls ? createSecureServer(options.tls, listener) : createServer(listener)
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== paths.events || !activeSession(req)) {
      socket.end(`HTTP/1.1 ${req.url === paths.events ? '401 Unauthorized' : '404 Not Found'}\r\nConnection: close\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock controller did not bind')
  const url = `${options.tls ? 'https' : 'http'}://127.0.0.1:${address.port}`
  const simulation = options.lively ? setInterval(tick, 10_000) : undefined
  simulation?.unref()

  function watchdogProbe(ip: string, at = now()) {
    const client = [...clients.values()].find(client => client.ip === ip)
    if (!client?.online) return null
    if (options.lively && client.hostname === 'workbench-camera' && (at - started) % 240_000 >= 170_000) return null
    return 3 + Math.abs(Math.floor(at / 1000) % 8)
  }

  function probe(id: string, at = now()) {
    const profile = profiles.get(id)
    if (!profile) return null
    const scriptedDown = outages.get(id)?.some(outage => at >= outage.start && at < outage.end)
    const devFlap = options.lively && id === 'demo-vpn-4' && (at - started) % 480_000 >= 420_000
    const up = !scriptedDown && !devFlap
    const jitter = Math.abs(Math.floor(at / 1000) % 7) - 3
    return { up, latencyMs: up ? profile.latency + jitter : null, publicIp: profile.ip, country: profile.country }
  }

  return {
    config: { url, username: MOCK_USERNAME, password: MOCK_PASSWORD, site: MOCK_SITE, verifyMode: 'insecure' as const },
    paths, emit, tick, setOnline,
    scenario(kind: Parameters<typeof fleet.scenario>[0], source: 'ws' | 'poll' = 'ws') {
      if (kind === 'config-then-outage') togglePortForward()
      const result = fleet.scenario(kind)
      emit('device:sync', devices)
      if (source === 'ws' && (kind === 'roam' || kind === 'sticky' || kind === 'recover')) emit('sta:sync', [...clients.values()].filter(fleet.activeClient))
      return result
    },
    get loginAttempts() { return logins },
    get mutationCount() { return mutations },
    expireSession() {
      sessions.clear()
      for (const ws of wss.clients) ws.close(4001)
    },
    injectFailure(method: string, path: string, value: Failure) {
      const key = `${method} ${new URL(path, url).pathname}`
      const queue = failures.get(key) ?? []
      queue.push(value)
      failures.set(key, queue)
    },
    wrongFingerprint: '00'.repeat(32),
    scheduleOutage(id: string, outage: Outage) {
      const schedule = outages.get(id) ?? []
      schedule.push(outage)
      outages.set(id, schedule)
    },
    probe, watchdogProbe,
    trace() {
      const route = [...routes.values()].find(route => route.description === '[unifire-probe] sweep' && route.enabled)
      const answer = route?.network_id ? probe(route.network_id) : null
      return answer?.up ? `ip=${answer.publicIp}\nloc=${answer.country}\ncolo=TPE\n` : null
    },
    async close() {
      clearInterval(simulation)
      for (const timer of timers) clearTimeout(timer)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    },
  }
}

export type MockController = Awaited<ReturnType<typeof startMockController>>
