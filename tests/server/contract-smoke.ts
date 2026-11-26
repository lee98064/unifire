import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { ZodError } from 'zod'
import { api, type ApiName } from '../../shared/api'
import { ApprovalItem, Client, Person } from '../../shared/schemas/access'
import { SetupStatus } from '../../shared/schemas/auth'
import { GuestWifi, PoeWatchdog, Rule, WolTarget } from '../../shared/schemas/automation'
import { ControllerStatus } from '../../shared/schemas/controller'
import { Egress } from '../../shared/schemas/egress'
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
    const body = options.body === undefined ? undefined : JSON.stringify(ep.input?.parse(options.body) ?? options.body)
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
  const { timezone } = Settings.parse(await get('settings'))
  const now = Date.now()
  const monthFormat = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' })
  const monthAt = (ts: number) => {
    const parts = monthFormat.formatToParts(ts)
    return ['year', 'month'].map(type => parts.find(part => part.type === type)!.value).join('-')
  }
  const month = monthAt(now)
  const options: Partial<Record<ApiName, Parameters<typeof call>[1]>> = {
    egressHistory: { params: { id: egress.id }, query: { range: '24h' } },
    managedRoute: { params: { id: route.id } },
    managedRoutePreview: { params: { id: route.id }, query: { hours: '24' } },
    switchLog: { query: { limit: '10' } },
    client: { params: { mac: client.mac } },
    clientUsage: { params: { mac: client.mac }, query: { range: '24h' } },
    personQuotas: { params: { id: person.id } },
    extensionRequests: { query: { status: 'pending' } },
    presence: { query: { from: String(now - 86_400_000), to: String(now) } },
    rule: { params: { id: rule.id } },
    ruleRuns: { query: { limit: '10' } },
    watchdogEvents: { params: { id: watchdog.id } },
    kiosk: { params: { token: wifi.kioskToken } },
    snapshotDiff: { query: { from: snapshot.id } },
    snapshotItem: { params: { id: snapshot.id, resource: 'trafficroutes', itemId } },
    audit: { query: { limit: '10' } },
    ispReport: { query: { month } },
    usageReport: { query: { range: '7d' } },
  }
  const allReads = (Object.keys(api) as ApiName[]).filter(name => api[name].method === 'GET')
  const readResults = await Promise.allSettled(allReads.map(name => get(name, options[name])))
  assert.ok(readResults.every(result => result.status === 'fulfilled'), 'One or more contract GETs failed')
  assert.equal(covered.size, allReads.length)
  const dashboard = DashboardSummary.parse(values.get('dashboard'))
  assert.ok(dashboard.wans.some(wan => wan.rxBps !== null && wan.txBps !== null))
  assert.ok(dashboard.throughput.length > 0 && dashboard.throughput.length <= 60)
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

  await call('controllerMode', { body: { mode: 'dry-run' } })
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
