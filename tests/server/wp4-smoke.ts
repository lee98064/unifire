import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { api } from '../../shared/api'
import { SetupStatus } from '../../shared/schemas/auth'
import { Paged } from '../../shared/schemas/common'
import { ProbeOverview } from '../../shared/schemas/egress'
import { AuditEvent, RestorePlan, Snapshot, SnapshotDiff, SnapshotItem } from '../../shared/schemas/insight'

const origin = process.argv[2] ?? 'http://127.0.0.1:3884'
const production = process.argv.includes('--production-startup')
let cookie = ''

async function call(endpoint: typeof api[keyof typeof api], body?: unknown, path = endpoint.path) {
  const response = await fetch(new URL(path, origin), {
    method: endpoint.method, signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await response.json()
  assert.equal(response.status, 200, `${endpoint.method} ${path} returned ${JSON.stringify(data)}`)
  const session = response.headers.getSetCookie().find(value => value.startsWith('unifire-session='))
  if (session) cookie = session.split(';')[0] ?? ''
  return endpoint.output.parse(data)
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, attempts = 50, interval = 100) {
  for (let i = 0; i < attempts; i++) {
    const result = await read()
    if (ready(result)) return result
    await delay(interval)
  }
  throw new Error('Timed out waiting for a mock HTTP result')
}

const setup = SetupStatus.parse(await call(api.setupStatus))
assert.equal(setup.mock, true)
assert.equal(setup.needsAdmin, true, 'use a fresh mock data directory')
await call(api.setupAdmin, { username: 'wp4-smoke', displayName: 'WP4 smoke admin', password: 'WP4 test password only', locale: 'en' })
assert.ok(cookie)

if (production) {
  const listAudit = async (path: string) => Paged(AuditEvent).parse(await call(api.audit, undefined, path)).items
  const probes = await until(async () => ProbeOverview.parse(await call(api.probes)),
    value => value.routes.length > 0 && value.routes.every(route => route.state === 'ok'))
  const switches = () => listAudit('/api/audit?category=route&q=Lab%20NAS')
  const summary = () => listAudit('/api/audit?category=egress&q=probesProvisioned')
  await until(switches, items => items.some(item => item.action === 'route.switched'))
  await until(summary, items => items.length > 0)
  await delay(2_000)
  assert.equal((await switches()).filter(item => item.action === 'route.switched').length, 1)
  const provisioning = await summary()
  assert.equal(provisioning.length, 1)
  assert.deepEqual(provisioning[0]?.messageParams, { created: String(probes.routes.length), repaired: '0', removed: '0' })
  assert.equal((await listAudit('/api/audit?category=route&q=%5Bunifire-probe%5D')).length, 0)
  console.log('Production mock startup reconciled Lab NAS and provisioned the probe set exactly once.')
}

const page = Paged(Snapshot).parse(await call(api.snapshots, undefined, '/api/snapshots?limit=2'))
assert.equal(page.items.length, 2)
assert.ok(page.nextCursor)
const all = Paged(Snapshot).parse(await call(api.snapshots, undefined, '/api/snapshots?limit=50'))
const historical = all.items.filter(item => item.trigger === 'scheduled')
assert.equal(historical.length, 3)
assert.ok(historical.every(item => item.complete && Object.keys(item.counts).length === 12))
const pageTwo = Paged(Snapshot).parse(await call(api.snapshots, undefined, `/api/snapshots?limit=2&cursor=${page.nextCursor}`))
assert.ok(pageTwo.items.every(item => !page.items.some(first => first.id === item.id)))

const manual = Snapshot.parse(await call(api.snapshotCreate, { note: 'WP4 HTTP smoke' }))
assert.equal(manual.complete, true)
assert.equal(manual.trigger, 'manual')
const item = SnapshotItem.parse(await call(api.snapshotItem, undefined, `/api/snapshots/${manual.id}/items/wlanconf/demo-wlan-0`))
assert.equal(item.doc.x_passphrase, null)

const from = historical[1]!.id
const to = historical[0]!.id
const saved = SnapshotDiff.parse(await call(api.snapshotDiff, undefined, `/api/snapshots/diff?from=${from}&to=${to}`))
assert.equal(saved.toId, to)
assert.ok(saved.changes.length >= 2)
const readLive = async () => SnapshotDiff.parse(await call(api.snapshotDiff, undefined, `/api/snapshots/diff?from=${from}`))
const live = await readLive()
assert.equal(live.toId, null)
assert.ok(live.changes.some(change => change.resource === 'wlanconf' && change.restorable))
const restorePath = `/api/snapshots/${from}/restore`
const items = [{ resource: 'wlanconf', itemId: 'demo-wlan-0' }]
const preview = RestorePlan.parse(await call(api.snapshotRestore, { items }, restorePath))
assert.equal(preview.dryRun, true)
assert.equal(preview.steps[0]?.result, 'pending')
assert.equal(preview.steps[0]?.body?.x_passphrase, null)
const restore = RestorePlan.parse(await call(api.snapshotRestore, { items, dryRun: false }, restorePath))
assert.equal(restore.dryRun, false)
assert.equal(restore.steps[0]?.result, 'applied')
assert.ok(!(await readLive()).changes.some(change => change.resource === 'wlanconf' && change.itemId === 'demo-wlan-0'))
const audit = Paged(AuditEvent).parse(await call(api.audit, undefined, `/api/audit?category=snapshot&actor=user&q=${encodeURIComponent(item.label)}`))
assert.ok(audit.items.some(value => value.messageKey === 'audit.snapshot.restoreApplied'))
await call(api.snapshotDelete, undefined, `/api/snapshots/${manual.id}`)
const deleted = await fetch(new URL(`/api/snapshots/${manual.id}/items/wlanconf/demo-wlan-0`, origin), { headers: { cookie } })
assert.equal(deleted.status, 404)
console.log('WP4 mock HTTP smoke passed for all 6 snapshot endpoints and audit filtering.')

if (process.argv.includes('--dev-external')) {
  const changes = () => call(api.audit, undefined, '/api/audit?actor=external&category=config&q=Demo%20port%20forward')
    .then(value => Paged(AuditEvent).parse(value).items)
  const entries = await until(changes, rows => rows.some(row => row.action === 'config.changed'), 25, 4_000)
  assert.ok(entries.some(row => row.diff?.some(change => change.path === 'enabled')))
  console.log('Development mock port-forward change appeared in the external audit feed.')
}
