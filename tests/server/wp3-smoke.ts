import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { ZodType } from 'zod'
import { api } from '../../shared/api'
import { SetupStatus } from '../../shared/schemas/auth'
import { Egress, EgressHistory, ProbeOverview, SweepStatus } from '../../shared/schemas/egress'
import { ManagedRoute, RoutePreview, UnifiRoute } from '../../shared/schemas/routes'
import { DashboardSummary } from '../../shared/schemas/system'
import { emptyGrid } from '../../shared/utils/schedule'

const origin = process.argv[2] ?? 'http://127.0.0.1:3873'
const exercised = new Set<string>()
let cookie = ''

async function call(endpoint: { method: string, path: string, output: ZodType }, body?: unknown, path = endpoint.path) {
  const response = await fetch(new URL(path, origin), {
    method: endpoint.method, signal: AbortSignal.timeout(15_000), headers: {
      accept: 'application/json', ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await response.json()
  assert.equal(response.status, 200, `${endpoint.method} ${path}: ${JSON.stringify(data)}`)
  const session = response.headers.getSetCookie().find(value => value.startsWith('unifire-session='))
  if (session) cookie = session.split(';')[0] ?? ''
  exercised.add(`${endpoint.method} ${endpoint.path}`)
  return endpoint.output.parse(data)
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  for (let i = 0; i < 50; i++) {
    const result = await read()
    if (ready(result)) return result
    await delay(100)
  }
  throw new Error('Timed out waiting for a WP3 endpoint to settle')
}

const setup = SetupStatus.parse(await call(api.setupStatus))
assert.equal(setup.mock, true)
const admin = { username: 'wp3-smoke', displayName: 'WP3 smoke admin', password: 'WP3 test password only', locale: 'en' }
if (setup.needsAdmin) await call(api.setupAdmin, admin)
else await call(api.login, { username: admin.username, password: admin.password })
assert.ok(cookie)

const routes = ManagedRoute.array().parse(await call(api.managedRoutes))
assert.equal(routes.length, 3)
assert.ok(routes.some(route => route.name === 'Lab NAS' && route.activeOverride))
const all = UnifiRoute.array().parse(await call(api.unifiRoutes))
assert.ok(all.some(route => route.ownership === 'managed' && route.managedRouteId))
assert.ok(all.some(route => route.ownership === 'excluded' && route.description === 'proxy hourly egress (external script)'))

const exitIds = Egress.array().parse(await call(api.egresses)).map(row => row.id)
const first = exitIds[0]!
const second = exitIds[1]!
const route = ManagedRoute.parse(await call(api.managedRouteCreate, { mode: 'create', name: 'WP3 smoke route', defaultEgressId: first,
  targets: [{ type: 'CLIENT', mac: '02:00:00:00:00:01' }], matchingTarget: 'IP', destinations: ['192.0.2.5/32'] }))
const path = `/api/managed-routes/${route.id}`
assert.equal(ManagedRoute.parse(await call(api.managedRoute, undefined, path)).id, route.id)
assert.equal(ManagedRoute.parse(await call(api.managedRouteUpdate, { killSwitch: false }, path)).killSwitch, false)
await call(api.managedRouteSchedule, { grid: emptyGrid(second), timezone: 'UTC' }, path + '/schedule')
await until(async () => ManagedRoute.parse(await call(api.managedRoute, undefined, path)), route => route.actualEgressId === second)
const overridden = ManagedRoute.parse(await call(api.managedRouteOverride, { egressId: first, minutes: 1 }, path + '/override'))
assert.equal(overridden.desired.reason, 'override')
const upcoming = RoutePreview.parse(await call(api.managedRoutePreview, undefined, path + '/preview?hours=2'))
assert.deepEqual(upcoming.segments.map(segment => segment.reason), ['override', 'schedule'])
await call(api.managedRouteOverrideClear, undefined, path + '/override')
assert.equal(ManagedRoute.parse(await call(api.managedRouteSchedule, null, path + '/schedule')).schedule, null)
await call(api.managedRouteResume, undefined, path + '/resume')
await call(api.switchLog, undefined, `/api/switch-log?managedRouteId=${route.id}&limit=1`)
await call(api.managedRouteRelease, undefined, path + '?deleteFromUnifi=true')

await call(api.probes)
const provisioned = ProbeOverview.parse(await call(api.probesProvision))
assert.ok(provisioned.routes.some(route => route.state === 'ok'))
await call(api.egressUpdate, { probeEnabled: true }, `/api/egresses/${first}`)
assert.equal(EgressHistory.parse(await call(api.egressHistory, undefined, `/api/egresses/${first}/history?range=1h`)).egressId, first)
assert.equal(SweepStatus.parse(await call(api.sweepStart, { egressIds: [first, second] })).running, true)
const completed = await until(async () => SweepStatus.parse(await call(api.sweepStatus)), sweep => !sweep.running)
assert.ok(completed.results.length === 2 && completed.results.every(result => result.ok))
const refreshed = Egress.array().parse(await call(api.egresses))
assert.ok(refreshed.find(exit => exit.id === first)?.publicIp?.ip)
assert.ok(DashboardSummary.parse(await call(api.dashboard)).recentSwitches.some(entry => entry.managedRouteId === route.id))
const removed = ProbeOverview.parse(await call(api.probesCleanup))
assert.ok(removed.routes.every(route => route.state !== 'ok'))
const total = exercised.size - 2 // Setup and sign-in are shared prerequisites.
console.log(`WP3 mock HTTP smoke passed for ${total} routing, probe, egress, and dashboard endpoints.`)
