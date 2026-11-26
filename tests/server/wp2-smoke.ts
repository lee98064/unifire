import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { api } from '../../shared/api'
import { SetupStatus } from '../../shared/schemas/auth'
import { Client } from '../../shared/schemas/access'
import { CertificateInfo, ControllerStatus } from '../../shared/schemas/controller'
import { Egress } from '../../shared/schemas/egress'
import { DashboardSummary } from '../../shared/schemas/system'
import { startMockController } from '../../server/unifi/mock'

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3872')
let cookie = ''

async function request(endpoint: { method: string, path: string }, body?: unknown, path = endpoint.path, signedIn = true) {
  const res = await fetch(new URL(path, origin), {
    method: endpoint.method, signal: AbortSignal.timeout(30_000),
    headers: {
      accept: 'application/json',
      ...(signedIn && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const session = res.headers.getSetCookie().find(value => value.startsWith('unifire-session='))
  if (signedIn && session) cookie = session.split(';')[0] ?? ''
  return { res, data: await res.json() as unknown }
}

async function call<T>(endpoint: { method: string, path: string, output: z.ZodType }, body?: unknown,
  path = endpoint.path, schema?: z.ZodType<T>) {
  const { res, data } = await request(endpoint, body, path)
  const error = z.object({ data: z.object({ code: z.string() }) }).safeParse(data)
  assert.equal(res.status, 200, `${endpoint.method} ${path} (${error.data?.data.code ?? '-'}): ${res.status}`)
  endpoint.output.parse(data)
  return schema?.parse(data)
}

const tls = {
  key: readFileSync(new URL('./fixtures/wp2-test-key.pem', import.meta.url)),
  cert: readFileSync(new URL('./fixtures/wp2-test-cert.pem', import.meta.url)),
}

async function smoke() {
  const status = await call(api.setupStatus, undefined, undefined, SetupStatus)
  assert.equal(status?.mock, true)
  const admin = { username: 'wp2-smoke', displayName: 'WP2 smoke admin', password: 'WP2 test password only', locale: 'en' }
  if (status.needsAdmin) await call(api.setupAdmin, admin)
  else await call(api.login, { username: admin.username, password: admin.password })
  assert.ok(cookie.startsWith('unifire-session='))
  const unauthorized = await request(api.controller, undefined, undefined, false)
  assert.equal(unauthorized.res.status, 401)

  const ctl = await call(api.controller, undefined, undefined, ControllerStatus)
  assert.equal(ctl?.mock, true)
  await call(api.controllerMode, { mode: 'dry-run' })
  const dry = await call(api.controllerProbe, undefined, undefined, ControllerStatus)
  assert.equal(dry?.capabilities.find(row => row.key === 'routes.create')?.status, 'skipped')
  await call(api.controllerMode, { mode: 'live' })
  const synced = await call(api.controllerProbe, undefined, undefined, ControllerStatus)
  assert.equal(synced?.capabilities.find(row => row.key === 'routes.create')?.status, 'ok')
  assert.equal(synced.capabilities.find(row => row.key === 'routes.delete')?.status, 'ok')
  await call(api.controllerSync)

  const fake = await startMockController({ tls })
  try {
    const cert = await call(api.setupInspect, { url: fake.config.url }, undefined, CertificateInfo)
    assert.ok(cert?.selfSigned)
    const input = { ...fake.config, verifyMode: 'fingerprint', fingerprint: cert.fingerprint }
    const tested = await call(api.setupTest, input, undefined, ControllerStatus)
    assert.equal(tested?.connected, true)
    assert.equal(tested.mode, 'dry-run')
    assert.equal(fake.mutationCount, 0)
    const saved = await call(api.controllerSave, input, undefined, ControllerStatus)
    assert.equal(saved?.mock, true)
    assert.equal(fake.mutationCount, 0)
  } finally { await fake.close() }

  await call(api.networks)
  const exits = await call(api.egresses, undefined, undefined, Egress.array())
  assert.equal(exits?.length, 11)
  const updatedEgress = await call(api.egressUpdate, { color: '#123456', probeEnabled: true },
    '/api/egresses/demo-wan-1', Egress)
  assert.equal(updatedEgress?.color, '#123456')
  assert.equal(updatedEgress.probe.enabled, true)
  await call(api.unifiRoutes)
  await call(api.wlans)
  const list = await call(api.clients, undefined, '/api/clients?online=true', Client.array())
  const target = list?.find(client => client.online && client.mac !== synced.selfMac)
  assert.ok(target)
  const search = await call(api.clients, undefined, `/api/clients?q=${encodeURIComponent(target.mac)}`, Client.array())
  assert.deepEqual(search?.map(client => client.mac), [target.mac])
  const offline = await call(api.clients, undefined, '/api/clients?online=false', Client.array())
  assert.ok(offline?.length)
  assert.ok(offline.every(client => !client.online))
  const path = `/api/clients/${encodeURIComponent(target.mac)}`
  await call(api.client, undefined, path)
  const labelled = await call(api.clientUpdate, { alias: 'WP2 smoke client' }, path, Client)
  assert.equal(labelled?.displayName, 'WP2 smoke client')
  const action = (name: 'block' | 'unblock' | 'kick') => call(api.clientAction, { action: name }, path + '/action', Client)
  const blocked = await action('block')
  assert.ok(blocked?.blocked)
  assert.ok(blocked.blockReasons.some(reason => reason.source === 'manual'))
  assert.equal((await action('unblock'))?.blocked, false)
  assert.equal((await action('kick'))?.online, false)
  const dashboard = await call(api.dashboard, undefined, undefined, DashboardSummary)
  assert.equal(dashboard?.wans.length, 3)
  assert.equal(dashboard.routes.unifiTotal, 20)
  assert.ok(dashboard.throughput.length)
  console.log('WP2 mock HTTP smoke passed for all 17 endpoints.')
}

await smoke()
