import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { ZodError } from 'zod'
import { api, type ApiName } from '../../shared/api'
import { ApprovalItem, Client, Person } from '../../shared/schemas/access'
import { SetupStatus } from '../../shared/schemas/auth'
import { GuestWifi, PoeWatchdog, Rule, RuleRun, WolTarget } from '../../shared/schemas/automation'
import { ControllerStatus } from '../../shared/schemas/controller'
import { Egress } from '../../shared/schemas/egress'
import { Paged } from '../../shared/schemas/common'
import { ClientRoams, Incident, IncidentDetail, InfraDevice, InfraDeviceDetail, InfraReport, PoeOverview, PoeQualification, PoeSchedule, PortDetail, PortEvent, Room, RoomTimeline, StickyClient, Topology } from '../../shared/schemas/infra'
import { IspReport, Snapshot, SpeedtestStatus, UsageReport } from '../../shared/schemas/insight'
import { ManagedRoute, UnifiRoute } from '../../shared/schemas/routes'
import { DashboardSummary, Settings } from '../../shared/schemas/system'
import { emptyGrid } from '../../shared/utils/schedule'

const origin = process.argv[2] ?? 'http://127.0.0.1:3000'
const admin = { username: 'contract-smoke', displayName: 'Contract smoke', password: 'Contract-SMOKE-throwaway-702!' }
const forward = process.env.UNIFIRE_SMOKE_FORWARDED === 'true'
const checks: { check: string, path: string, result: string }[] = []
const covered = new Set<ApiName>()
const values = new Map<ApiName, unknown>()
let cookie = ''

function pathFor(name: ApiName, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  const path = api[name].path.replace(/:(\w+)/g, (_, key: string) => {
    assert.ok(params[key], `Missing path parameter ${key}`)
    return encodeURIComponent(params[key])
  })
  const search = new URLSearchParams(query).toString()
  return search ? `${path}?${search}` : path
}

async function sse(response: Response) {
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
  const reader = response.body?.getReader()
  assert.ok(reader)
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (buffer.length < 16_384) {
      const { value, done } = await reader.read()
      assert.equal(done, false, 'SSE ended before sending an event')
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const lines = buffer.slice(0, end).split('\n')
        const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (type === 'hello') return { type, data: JSON.parse(data) as unknown }
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf('\n\n')
      }
    }
    throw new Error('No hello event in the SSE response')
  } finally {
    await reader.cancel()
  }
}

async function call(name: ApiName, options: {
  params?: Record<string, string>, query?: Record<string, string>, body?: unknown, label?: string
} = {}) {
  const ep = api[name]
  const row = { check: options.label ?? name, path: `${ep.method} ${ep.path}`, result: 'PASS' }
  try {
    const validated = options.body === undefined ? undefined : ep.input?.parse(options.body) ?? options.body
    // Send the original patch so the server proves omitted fields keep their saved values.
    const body = JSON.stringify(name === 'poeScheduleUpdate' || name === 'roomUpdate' ? options.body : validated)
    if (ep.method === 'GET' && ep.input) ep.input.parse(options.query ?? {})
    const response = await fetch(new URL(pathFor(name, options.params, options.query), origin), {
      method: ep.method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: name === 'events' ? 'text/event-stream' : 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(ep.auth !== 'public' && cookie && { cookie }),
        ...(forward && { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'wp7.example.test' }),
      },
      body,
    })
    if (name === 'login' || name === 'setupAdmin') {
      const next = response.headers.getSetCookie().filter(header => header.startsWith('unifire-session=')).at(-1)
      if (next) cookie = next.split(';', 1)[0]!
    }
    assert.equal(response.status, 200, `HTTP ${response.status}`)
    const parsed: unknown = ep.output.parse(name === 'events' ? await sse(response) : await response.json())
    if (ep.method === 'GET') covered.add(name)
    return parsed
  } catch (error) {
    row.result = error instanceof ZodError ? `FAIL (schema at ${error.issues.map(issue => issue.path.join('.') || '<root>').join(', ')})`
      : error instanceof Error && error.message.startsWith('HTTP ') ? `FAIL (${error.message})` : 'FAIL'
    throw error
  } finally {
    checks.push(row)
  }
}

async function get(name: ApiName, options?: Parameters<typeof call>[1]) {
  if (!values.has(name)) values.set(name, await call(name, options))
  return values.get(name)
}

function first<T>(rows: T[], fixture: string) {
  assert.ok(rows.length, `Missing ${fixture} in the mock fixtures`)
  return rows[0]!
}

async function run() {
  const setup = SetupStatus.parse(await get('setupStatus'))
  assert.equal(setup.mock, true, 'The smoke test mutates data and requires NUXT_MOCK_CONTROLLER=true')
  if (setup.needsAdmin) await call('setupAdmin', { body: admin })
  await call('login', { body: { username: admin.username, password: admin.password } })
  assert.ok(cookie, 'No session cookie received')
  const controller = ControllerStatus.parse(await get('controller'))
  if (!controller.connected) {
    const deadline = Date.now() + 15_000
    while (!ControllerStatus.parse(await call('controller', { label: 'controller readiness' })).connected) {
      assert.ok(Date.now() < deadline, 'Mock controller readiness timed out')
      await delay(250)
    }
  }

  const egress = first(Egress.array().parse(await get('egresses')), 'egress')
  const route = first(ManagedRoute.array().parse(await get('managedRoutes')), 'managed route')
  const unifiRoutes = UnifiRoute.array().parse(await get('unifiRoutes'))
  const client = first(Client.array().parse(await get('clients')), 'client')
  const person = first(Person.array().parse(await get('people')), 'person')
  const rule = first(Rule.array().parse(await get('rules')), 'rule')
  const watchdog = first(PoeWatchdog.array().parse(await get('watchdogs')), 'watchdog')
  const wifi = GuestWifi.parse(await get('guestWifi'))
  assert.ok(wifi.kioskToken, 'Missing mock kiosk token')
  if (forward) assert.ok(wifi.kioskUrl?.startsWith('https://wp7.example.test/kiosk/'))
  const snapshot = first(Snapshot.array().parse((await get('snapshots', { query: { limit: '10' } }) as { items: unknown }).items), 'snapshot')
  const itemId = first(unifiRoutes.filter(item => item.ownership !== 'probe'), 'UniFi route').id
  const devices = InfraDevice.array().parse(await get('devices'))
  assert.equal(devices.length, 6)
  const ap = devices.find(device => device.name === 'AP Living Room')!
  const gateway = devices.find(device => device.type === 'gateway')!
  const core = devices.find(device => device.model === 'USPM16P')!
  assert.equal(devices.find(device => device.model === 'UDMA69B')?.type, 'ap')
  assert.equal(devices.find(device => device.name === 'AP Garden')?.uplink?.type, 'wireless')
  assert.ok(ap && gateway && core)
  const deviceParams = { mac: ap.mac }
  const { timezone } = Settings.parse(await get('settings'))
  const now = Date.now()
  const monthFormat = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' })
  const monthAt = (ts: number) => {
    const parts = monthFormat.formatToParts(ts)
    return ['year', 'month'].map(type => parts.find(part => part.type === type)!.value).join('-')
  }
  const month = monthAt(now)
  const options: Partial<Record<ApiName, Parameters<typeof call>[1]>> = {
    device: { params: deviceParams },
    portDetail: { params: { mac: core.mac, idx: '8' }, query: { range: '24h' } },
    portEvents: { query: { switchMac: core.mac, limit: '10' } },
    energy: { query: { period: 'day' } },
    deviceSeries: { params: deviceParams, query: { range: '24h' } },
    deviceEvents: { params: deviceParams, query: { from: String(now - 86_400_000), to: String(now) } },
    egressHistory: { params: { id: egress.id }, query: { range: '24h' } },
    managedRoute: { params: { id: route.id } },
    managedRoutePreview: { params: { id: route.id }, query: { hours: '24' } },
    switchLog: { query: { limit: '10' } },
    client: { params: { mac: client.mac } },
    clientUsage: { params: { mac: client.mac }, query: { range: '24h' } },
    personQuotas: { params: { id: person.id } },
    extensionRequests: { query: { status: 'pending' } },
    clientRoams: { params: { mac: client.mac }, query: { from: String(now - 86_400_000), to: String(now) } },
    roomTimeline: { query: { from: String(now - 86_400_000), to: String(now) } },
    presence: { query: { from: String(now - 86_400_000), to: String(now) } },
    rule: { params: { id: rule.id } },
    ruleRuns: { query: { limit: '10' } },
    watchdogEvents: { params: { id: watchdog.id } },
    kiosk: { params: { token: wifi.kioskToken } },
    snapshotDiff: { query: { from: snapshot.id } },
    snapshotItem: { params: { id: snapshot.id, resource: 'trafficroutes', itemId } },
    audit: { query: { limit: '10' } },
    ispReport: { query: { month } },
    infraReport: { query: { month } },
    usageReport: { query: { range: '7d' } },
  }
  const allReads = (Object.keys(api) as ApiName[]).filter(name => api[name].method === 'GET')
  const readResults = await Promise.allSettled(allReads.filter(name => name !== 'incident').map(name => get(name, options[name])))
  assert.ok(readResults.every(result => result.status === 'fulfilled'), 'One or more contract GETs failed')
  const topology = Topology.parse(values.get('topology'))
  const topologyRoot = 'dev:' + gateway.mac
  assert.deepEqual(topology.nodes.filter(node => node.parentId === null).map(node => node.id), [topologyRoot])
  assert.ok(topology.nodes.some(node => node.kind === 'egress' && node.parentId === topologyRoot))
  assert.ok(topology.nodes.some(node => node.id === 'clients:' + ap.mac && node.members.length > 0))
  assert.ok(topology.nodes.some(node => node.kind === 'client_group' && node.members.some(member => member.wired)))
  const room = Room.parse(await call('roomCreate', { body: { name: 'WP10 contract living room', floor: 'Ground', order: 4 } }))
  const roomParams = { id: room.id }
  const editedRoom = Room.parse(await call('roomUpdate', { params: roomParams, body: { name: 'WP10 living room' } }))
  assert.equal(editedRoom.floor, 'Ground')
  assert.equal(editedRoom.order, 4)
  const assigned = Room.array().parse(await call('roomAssign', { body: { apMac: ap.mac, roomId: room.id } }))
  assert.deepEqual(assigned.find(item => item.id === room.id)?.apMacs, [ap.mac])
  const study = devices.find(device => device.model === 'UDMA69B')!
  const studyAssigned = InfraDevice.parse(await call('deviceUpdate', { params: { mac: study.mac }, body: { roomId: room.id } }))
  assert.equal(studyAssigned.roomId, room.id)
  const timeline = RoomTimeline.parse(await call('roomTimeline', { query: options.roomTimeline!.query }))
  assert.ok(timeline.people.some(item => item.personId === person.id))
  assert.deepEqual(timeline.rooms.find(item => item.id === room.id)?.apMacs, [ap.mac, study.mac].sort())
  await call('roomDelete', { params: roomParams })
  assert.equal(InfraDeviceDetail.parse(await call('device', { params: deviceParams })).roomId, null)
  const dashboard = DashboardSummary.parse(values.get('dashboard'))
  assert.ok(dashboard.wans.some(wan => wan.rxBps !== null && wan.txBps !== null))
  assert.ok(dashboard.throughput.length > 0 && dashboard.throughput.length <= 60)
  assert.equal(dashboard.infra.total, devices.length)
  assert.ok(dashboard.infra.poeWatts)
  assert.ok(dashboard.recentAudit.length > 0 && dashboard.recentAudit.length <= 10)
  assert.ok(UsageReport.parse(values.get('usageReport')).totals.rxBytes > 0)
  assert.ok(IspReport.parse(values.get('ispReport')).wans.length > 0)

  const created = ManagedRoute.parse(await call('managedRouteCreate', { body: {
    mode: 'create', name: 'WP7 contract route', targets: [{ type: 'CLIENT', mac: client.mac }], defaultEgressId: egress.id,
  } }))
  const params = { id: created.id }
  const scheduled = ManagedRoute.parse(await call('managedRouteSchedule', {
    params, body: { timezone, grid: emptyGrid(egress.id) },
  }))
  assert.ok(scheduled.schedule)
  const overridden = ManagedRoute.parse(await call('managedRouteOverride', { params, body: { egressId: egress.id, minutes: 5 } }))
  assert.ok(overridden.activeOverride)
  await call('personPause', { params: { id: person.id }, body: { minutes: 5 } })
  const approval = first(ApprovalItem.array().parse(values.get('approvals')), 'pending approval')
  await call('approvalDecide', { params: { mac: approval.mac }, body: { decision: 'approve' } })
  const newRule = Rule.parse(await call('ruleCreate', { body: {
    name: 'WP7 contract rule', description: null, enabled: false, trigger: { type: 'client.new' },
    conditions: [], actions: [{ type: 'delay', seconds: 1 }], cooldownSeconds: 0,
  } }))
  await call('ruleTest', { params: { id: newRule.id }, body: { dryRun: true } })
  const saved = Snapshot.parse(await call('snapshotCreate', { body: { note: 'WP7 contract smoke' } }))
  await call('snapshotDiff', { label: 'snapshot diff after mutation', query: { from: snapshot.id, to: saved.id } })
  await call('snapshotRestore', { params: { id: saved.id }, body: { dryRun: true,
    items: [{ resource: 'trafficroutes', itemId: created.unifiRouteId }] } })
  const rotated = GuestWifi.parse(await call('guestWifiRotate'))
  assert.ok(rotated.lastRotatedAt)
  const wol = first(WolTarget.array().parse(values.get('wolTargets')), 'WoL target')
  const woke = WolTarget.parse(await call('wolWake', { params: { id: wol.id } }))
  assert.ok(woke.lastWokeAt)
  const channel = await call('channelCreate', { body: { name: 'WP7 contract webhook', enabled: true,
    config: { type: 'webhook', url: 'http://127.0.0.1/unifire-demo-echo', secret: 'WP7-SMOKE-HOOK-531!' }, events: ['rule'] } }) as { id: string }
  await call('channelTest', { params: { id: channel.id } })

  const infraRule = Rule.parse(await call('ruleCreate', { body: {
    name: 'WP8 test overheat', description: null, enabled: false, trigger: { type: 'infra.overheat', mac: ap.mac, celsius: 65 },
    conditions: [], actions: [{ type: 'device.locate', mac: ap.mac, minutes: 1 }], cooldownSeconds: 0,
  } }))
  const infraRun = RuleRun.parse(await call('ruleTest', { params: { id: infraRule.id }, body: { dryRun: true } }))
  assert.equal(infraRun.event.temp, 65)
  assert.equal(infraRun.event.device, ap.name)
  assert.equal(infraRun.results[0]?.action, 'device.locate')
  const located = InfraDevice.parse(await call('deviceLocate', { params: deviceParams, body: { on: true, minutes: 1 } }))
  assert.equal(located.locating, true)
  const unlocated = InfraDevice.parse(await call('deviceLocate', { params: deviceParams, body: { on: false } }))
  assert.equal(unlocated.locating, false)
  const unconfirmed = await fetch(new URL(pathFor('deviceRestart', { mac: gateway.mac }), origin), {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(unconfirmed.status, 409)
  assert.equal((await unconfirmed.json()).data.code, 'GATEWAY_CONFIRMATION_REQUIRED')
  await call('deviceRestart', { params: { mac: gateway.mac }, body: { confirmGateway: true } })
  assert.equal(saved.counts.devices, 6)

  async function scenario(name: string) {
    const path = `/api/dev/mock/${name}`
    const check = { check: name, path: `POST ${path}`, result: 'PASS' }
    try {
      const response = await fetch(new URL(path, origin), { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(30_000) })
      assert.equal(response.status, 200, path)
      const body = await response.json()
      assert.equal(body.scenario, name)
      assert.equal(body.ok, true)
      return body.result
    } catch (error) {
      check.result = 'FAIL'
      throw error
    } finally {
      checks.push(check)
    }
  }
  const coreDetail = () => call('device', { params: { mac: core.mac } }).then(data => InfraDeviceDetail.parse(data))
  const apDetail = () => call('device', { params: deviceParams }).then(data => InfraDeviceDetail.parse(data))
  const incidentPage = (query?: Record<string, string>) => call('incidents', { query }).then(Paged(Incident).parse)
  const incidentDetail = (id: string) => call('incident', { params: { id } }).then(IncidentDetail.parse)
  const originalIncidents = Settings.parse(values.get('settings')).incidents
  await call('settingsSave', { body: { incidents: { ...originalIncidents, quietMinutes: 1 } } })

  async function waitForIncidentResolution(id: string) {
    const initial = await incidentDetail(id)
    const latest = initial.signals.at(-1)?.ts ?? initial.openedAt
    await delay(Math.max(0, latest + 60_000 - Date.now()))
    const deadline = Date.now() + 8_000
    let detail = await incidentDetail(id)
    while (detail.status === 'open' && Date.now() < deadline) {
      await delay(500)
      detail = await incidentDetail(id)
    }
    assert.equal(detail.status, 'resolved', `Incident did not resolve: ${detail.titleKey}`)
    assert.ok(detail.resolvedAt !== null && detail.resolvedAt < Date.now())
  }

  await scenario('reboot-ap')
  const rebooted = await apDetail()
  assert.ok(rebooted.uptimeSec !== null && rebooted.uptimeSec < 10)
  assert.ok(rebooted.lastReboot)
  const reboot = first((await incidentPage({ status: 'open' })).items, 'reboot incident')
  assert.equal(reboot.root?.kind, 'device_rebooted')
  assert.equal(reboot.root.ref?.id, ap.mac)
  assert.equal(reboot.severity, 'warning')
  await waitForIncidentResolution(reboot.id)

  const offline = await scenario('offline-switch') as { macs: string[] }
  assert.equal(offline.macs.length, 5)
  assert.equal((await coreDetail()).state, 'offline')
  const firstPage = await incidentPage({ limit: '1' })
  const outage = await incidentDetail(firstPage.items[0]!.id)
  assert.equal(outage.status, 'open')
  assert.equal(outage.root?.kind, 'device_offline')
  assert.equal(outage.root.ref?.id, core.mac)
  assert.equal(outage.severity, 'critical')
  assert.ok(outage.signals.some(signal => signal.kind === 'device_offline' && signal.ref?.id === ap.mac))
  assert.ok(outage.signals.some(signal => signal.kind === 'mass_disconnect'))
  assert.ok(firstPage.nextCursor)
  assert.equal((await incidentPage({ limit: '1', cursor: firstPage.nextCursor })).items[0]?.id, reboot.id)
  const incidentDashboard = DashboardSummary.parse(await call('dashboard', { label: 'Dashboard with one open incident' }))
  assert.equal(incidentDashboard.infra.openIncidents, 1)
  assert.equal(incidentDashboard.incidents[0]?.id, outage.id)
  const acknowledged = Incident.parse(await call('incidentUpdate', {
    params: { id: outage.id }, body: { acknowledged: true, note: 'Checked the core switch' },
  }))
  assert.equal(acknowledged.acknowledged, true)
  assert.equal((await incidentDetail(outage.id)).note, 'Checked the core switch')
  await scenario('recover')
  assert.equal((await coreDetail()).state, 'online')
  await waitForIncidentResolution(outage.id)

  await scenario('config-then-outage')
  const suspectOutages = (await incidentPage({ status: 'open' })).items
  assert.equal(suspectOutages.length, 1)
  const suspectOutage = await incidentDetail(suspectOutages[0]!.id)
  assert.equal(suspectOutage.root?.ref?.id, core.mac)
  assert.ok(suspectOutage.signals.some(signal => signal.kind === 'config_change' && signal.suspect
    && signal.ref?.label === 'Demo port forward'))
  assert.ok(suspectOutage.diff?.fromSnapshotId)
  await scenario('recover')
  const infra = InfraReport.parse(await call('infraReport', { query: { month: monthAt(suspectOutage.openedAt) } }))
  assert.ok(infra.incidents.count >= 3)
  assert.ok(infra.devices.some(device => device.mac === core.mac && device.outages >= 2))
  await call('settingsSave', { body: { incidents: originalIncidents } })

  const link = await scenario('downgrade-port') as { portIdx: number }
  assert.equal((await coreDetail()).ports.find(port => port.idx === link.portIdx)?.speedMbps, 100)
  const errors = await scenario('port-errors') as { rxErrors: number, txErrors: number }
  assert.ok(errors.rxErrors > 0 && errors.txErrors > 0)
  const flap = await scenario('flap-port') as { portIdx: number, up: boolean, linkDownCount: number }
  assert.ok(flap.linkDownCount > 0)
  assert.equal((await coreDetail()).ports.find(port => port.idx === flap.portIdx)?.up, flap.up)
  const roam = await scenario('roam') as { mac: string, from: string, to: string }
  assert.notEqual(roam.from, roam.to)
  assert.equal(Client.parse(await call('client', { params: { mac: roam.mac } })).uplinkMac, roam.to)
  const roamQuery = () => ({ from: String(now - 60_000), to: String(Date.now()) })
  const roaming = ClientRoams.parse(await call('clientRoams', { params: { mac: roam.mac }, query: roamQuery() }))
  assert.equal(roaming.events.filter(event => event.fromApMac === roam.from && event.toApMac === roam.to).length, 1)
  assert.ok(InfraDeviceDetail.parse(await call('device', { params: { mac: roam.to } })).roams24h!.in >= 1)
  await scenario('overheat')
  assert.ok((await apDetail()).issues.some(issue => issue.kind === 'overheat'))
  await scenario('firmware-available')
  assert.ok((await apDetail()).issues.some(issue => issue.kind === 'firmware_available'))
  await scenario('recover')
  await call('deviceRestart', { params: deviceParams, body: {} })

  const filtered = { switchMac: core.mac, unacknowledged: 'true', limit: '1' }
  const events = await call('portEvents', { query: filtered, label: 'WP9 first page' }) as { items: unknown[], nextCursor: string | null }
  const event = PortEvent.parse(first(events.items, 'port health event'))
  assert.ok(events.nextCursor, 'Expected more than one port event')
  const next = await call('portEvents', { query: { ...filtered, cursor: events.nextCursor } }) as { items: unknown[] }
  assert.notEqual(PortEvent.parse(first(next.items, 'second port event')).id, event.id)
  assert.equal(event.messageParams.port, String(event.portIdx))
  assert.equal(event.messageParams.portName, 'Desk')
  assert.match(event.messageParams.from ?? '', /^(?:\d+(?:\.\d+)?[MG])?$/)
  const acked = PortEvent.parse(await call('portEventUpdate', { params: { id: event.id }, body: { acknowledged: true } }))
  assert.equal(acked.acknowledged, true)
  const ackAll = await call('portEventsAckAll', { body: { switchMac: core.mac } }) as { count: number }
  assert.ok(ackAll.count > 0)
  const drawer = PortDetail.parse(await call('portDetail', { params: { mac: core.mac, idx: String(link.portIdx) } }))
  assert.ok(drawer.series.length > 0 && drawer.events.length > 0 && drawer.peers.length > 0)
  await call('energy', { query: { period: 'month' } })
  const poePort = { switchMac: core.mac, portIdx: 8 }
  const testPort = { switchMac: core.mac, portIdx: 3 }
  await call('controllerMode', { body: { mode: 'live' } })
  const qualified = PoeQualification.parse(await call('poeQualify', { body: { ...testPort, confirm: true } }))
  assert.equal(qualified.qualified, true)
  const wall = new Date()
  const hhmm = (offset: number) => new Date(wall.getTime() + offset * 60_000).toISOString().slice(11, 16)
  const day = (new Date(wall.getTime() - 60_000).getUTCDay() + 6) % 7
  const schedule = PoeSchedule.parse(await call('poeScheduleCreate', { body: {
    ...poePort, name: 'WP9 contract schedule', timezone: 'UTC', acknowledgedAp: true, mode: 'preview',
    offWindows: [{ days: [day], start: hhmm(-1), end: hhmm(5), enabled: true }],
  } }))
  assert.equal(schedule.state.status, 'preview')
  const id = { id: schedule.id }
  const active = PoeSchedule.parse(await call('poeScheduleUpdate', { params: id, body: { mode: 'active' } }))
  assert.equal(active.acknowledgedAp, true)
  assert.equal(active.timezone, 'UTC')
  assert.equal(active.state.actual, 'off')
  const poeOverridden = PoeOverview.parse(await call('poeOverride', { body: { ...poePort, action: 'set', on: true, minutes: 1 } }))
  assert.equal(poeOverridden.schedules.find(row => row.id === schedule.id)?.state.actual, 'on')
  await call('poeOverride', { body: { ...poePort, action: 'clear' } })
  const resumed = PoeSchedule.parse(await call('poeScheduleResume', { params: id }))
  assert.equal(resumed.state.actual, 'off')
  await call('poeScheduleDelete', { params: id })
  const restored = PoeOverview.parse(await call('poe', { label: 'WP9 restored power' }))
  assert.equal(restored.switches.find(row => row.mac === core.mac)?.ports.find(port => port.idx === 8)?.poe?.mode, 'auto')

  await call('controllerMode', { body: { mode: 'dry-run' } })
  const locatePreview = InfraDevice.parse(await call('deviceLocate', { params: deviceParams, body: {} }))
  assert.equal(locatePreview.locating, false)
  const preview = SpeedtestStatus.parse(await call('speedtestStart', { label: 'speedtest dry-run' }))
  assert.equal(preview.running, false)
  await call('controllerMode', { body: { mode: 'live' } })
  const started = SpeedtestStatus.parse(await call('speedtestStart'))
  assert.equal(started.running, true)
  const deadline = Date.now() + 15_000
  let measured
  do {
    await delay(500)
    measured = SpeedtestStatus.parse(await call('speedtest', { label: 'speedtest completion poll' }))
    assert.ok(Date.now() < deadline, 'Mock speedtest did not complete')
  } while (measured.running)
  assert.ok(measured.last && measured.last.ts >= started.startedAt!)
  const report = IspReport.parse(await call('ispReport', { label: 'ISP report after speedtest', query: { month: monthAt(measured.last.ts) } }))
  assert.ok(report.speedtests.some(test => test.ts === measured.last?.ts))
  assert.equal(UsageReport.parse(await call('usageReport', { label: 'monthly usage', query: { range: 'month', month } })).daily.length > 0, true)

  const originalSticky = Settings.parse(values.get('settings')).sticky
  await call('settingsSave', { body: { sticky: { ...originalSticky, enabled: true, minutes: 1, nudge: false } } })
  try {
    const weak = await scenario('sticky') as { mac: string, apMac: string, signal: number }
    const deadline = Date.now() + 70_000
    let flag
    while (Date.now() < deadline) {
      const result = StickyClient.array().parse(await call('stickyClients', { label: 'sticky detection' }))
      flag = result.find(row => row.mac === weak.mac)
      if (flag) break
      await delay(2_000)
    }
    assert.equal(flag?.status, 'sticky')
    assert.equal(flag?.apMac, weak.apMac)
    assert.equal(flag?.signal, weak.signal)
    const trail = ClientRoams.parse(await call('clientRoams', { params: { mac: weak.mac }, query: roamQuery() }))
    assert.ok(trail.apDwell.some(row => row.apMac === weak.apMac && row.minutes >= 1))
    assert.ok(trail.signal.some(row => row.apMac === weak.apMac && row.dbm === weak.signal))
    await scenario('recover')
    const recovered = StickyClient.array().parse(await call('stickyClients', { label: 'sticky recovery' }))
    assert.equal(recovered.find(row => row.mac === weak.mac)?.status, 'recovered')
  } finally {
    await call('settingsSave', { body: { sticky: originalSticky } })
  }

  const dashboardTimes = []
  for (let index = 0; index < 20; index++) {
    const at = performance.now()
    const response = await fetch(new URL(api.dashboard.path, origin), {
      headers: { cookie }, signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, 200)
    DashboardSummary.parse(await response.json())
    dashboardTimes.push(performance.now() - at)
  }
  dashboardTimes.sort((a, b) => a - b)
  const p95 = dashboardTimes[18]!
  const max = dashboardTimes[19]!
  console.log(`Dashboard HTTP p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms (20 mock requests)`)
  assert.ok(max < 150, 'Dashboard exceeded 150 ms')
  assert.equal(covered.size, allReads.length)
  return allReads.length
}

try {
  const getCount = await run()
  console.table(checks)
  console.log(`Contract smoke passed (${getCount}/${getCount} GET endpoints, ${checks.length} validated HTTP responses)`)
} catch (error) {
  console.table(checks)
  if (error instanceof Error && error.name === 'AssertionError') console.error(error.message)
  else console.error('Contract smoke failed. See the request table for the failed operation.')
  process.exitCode = 1
}
