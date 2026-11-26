import assert from 'node:assert/strict'
import { z } from 'zod'
import { api } from '../../shared/api'
import { SetupStatus } from '../../shared/schemas/auth'
import { ApprovalItem, Client, ClientUsage, ExtensionRequest, Group, MeSummary, Person, Quota, QuotaStatus } from '../../shared/schemas/access'

const origin = process.argv[2] ?? 'http://127.0.0.1:3875'
const token = Date.now().toString(36)
const admin = { username: 'wp5-smoke-admin', displayName: 'Smoke admin', password: 'WP5 development test only' }
const member = { ...admin, username: `wp5-${token}`, displayName: 'Smoke member' }
let cookie = ''

async function fetchApi(endpoint: { method: string, path: string, output: z.ZodType }, {
  path = endpoint.path, body, status = 200,
}: { path?: string, body?: unknown, status?: number } = {}) {
  const response = await fetch(new URL(path, origin), {
    method: endpoint.method, signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json', ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const session = response.headers.getSetCookie().find(item => item.startsWith('unifire-session='))
  if (session) cookie = session.split(';')[0]!
  const data: unknown = await response.json()
  assert.equal(response.status, status, `${endpoint.method} ${path}: ${JSON.stringify(data)}`)
  return status === 200 ? endpoint.output.parse(data) : data
}

const setup = SetupStatus.parse(await fetchApi(api.setupStatus))
assert.equal(setup.mock, true)
await fetchApi(setup.needsAdmin ? api.setupAdmin : api.login, { body: admin })
await fetchApi(api.dashboard)
const people = Person.array().parse(await fetchApi(api.people))
assert.ok(people.length >= 4)
const pending = ApprovalItem.array().parse(await fetchApi(api.approvals))
assert.ok(pending.length >= 2)
assert.ok(pending.some(row => row.randomizedMac))
const existing = Client.array().parse(await fetchApi(api.clients))
const first = people.find(person => person.deviceMacs.length > 0)!
const mac = first.deviceMacs[0]!
assert.ok(existing.some(client => client.mac === mac && client.personId === first.id))
const history = (range: string) => fetchApi(api.clientUsage, { path: `/api/clients/${mac}/usage?range=${range}` })
assert.equal(ClientUsage.parse(await history('24h')).buckets.length, 24)
assert.ok(ClientUsage.parse(await history('7d')).totals.rxBytes > 0)
assert.equal(ClientUsage.parse(await history('30d')).buckets.length, 30)
await fetchApi(api.presence, { path: `/api/presence/timeline?from=${Date.now() - 7 * 86_400_000}&to=${Date.now()}` })
await fetchApi(api.extensionRequests, { path: '/api/extension-requests?status=pending' })
await fetchApi(api.groups)
await fetchApi(api.quotas)

const person = Person.parse(await fetchApi(api.personCreate, { body: { name: 'Smoke person', color: '#4167A9' } }))
const personPath = `/api/people/${person.id}`
const updated = Person.parse(await fetchApi(api.personUpdate, {
  path: personPath, body: { avatar: 'WP', bedtime: [{ days: [0, 4], start: '22:00', end: '07:00' }] },
}))
assert.equal(updated.bedtime.length, 1)
const group = Group.parse(await fetchApi(api.groupCreate, {
  body: { name: 'Smoke group', color: '#4167A9', personIds: [person.id] },
}))
const groupPath = `/api/groups/${group.id}`
const renamed = Group.parse(await fetchApi(api.groupUpdate, { path: groupPath, body: { name: 'Smoke group updated' } }))
assert.deepEqual(renamed.personIds, [person.id])
await fetchApi(api.groupPause, { path: `${groupPath}/pause`, body: { minutes: 5 } })
await fetchApi(api.groupResume, { path: `${groupPath}/resume` })
await fetchApi(api.personPause, { path: `${personPath}/pause`, body: { minutes: null } })
await fetchApi(api.personResume, { path: `${personPath}/resume` })
await fetchApi(api.personAllow, { path: `${personPath}/allow`, body: { minutes: 5 } })
const assigned = Client.parse(await fetchApi(api.approvalDecide, { path: `/api/approvals/${pending[0]!.mac}`,
  body: { decision: 'approve', alias: 'Smoke alias', personId: person.id },
}))
assert.equal(assigned.personId, person.id)
assert.equal(assigned.displayName, 'Smoke alias')
assert.equal(assigned.approval, 'approved')
const quota = Quota.parse(await fetchApi(api.quotaCreate, { body: {
  name: 'Smoke quota', scope: { type: 'group', id: group.id }, metric: 'activeMinutes', period: 'daily',
  limit: 120, weekdayLimits: null, warnAtPct: 70, action: { type: 'notify' }, enabled: true,
} }))
const quotaPath = `/api/quotas/${quota.id}`
const quotaUpdated = Quota.parse(await fetchApi(api.quotaUpdate, { path: quotaPath, body: { limit: 180 } }))
assert.equal(quotaUpdated.warnAtPct, 70)
assert.equal(QuotaStatus.array().parse(await fetchApi(api.personQuotas, { path: `${personPath}/quotas` }))[0]?.limit, 180)

const adminSession = cookie
await fetchApi(api.userCreate, { body: { ...member, role: 'member', personId: person.id } })
cookie = ''
await fetchApi(api.login, { body: member })
const portal = MeSummary.parse(await fetchApi(api.meSummary))
assert.equal(portal.person?.id, person.id)
assert.deepEqual(portal.devices.map(client => client.mac), [assigned.mac])
assert.deepEqual(portal.quotas.map(status => status.quotaId), [quota.id])
assert.deepEqual(portal.requests, [])
await fetchApi(api.people, { status: 403 })
const request = ExtensionRequest.parse(await fetchApi(api.meRequest, { body: { quotaId: quota.id, amount: 15 } }))
const duplicate = await fetchApi(api.meRequest, { body: { amount: 5 }, status: 409 })
assert.equal(z.object({ data: z.object({ code: z.string() }) }).parse(duplicate).data.code, 'REQUEST_PENDING')
const memberSession = cookie
cookie = adminSession
await fetchApi(api.extensionDecide, { path: `/api/extension-requests/${request.id}`, body: { decision: 'approve', amount: 20 } })
cookie = memberSession
const approved = MeSummary.parse(await fetchApi(api.meSummary))
assert.equal(approved.quotas[0]?.bonus, 20)
assert.deepEqual(approved.requests.map(row => [row.id, row.status, row.amount]), [[request.id, 'approved', 20]])
cookie = adminSession
await fetchApi(api.quotaDelete, { path: quotaPath })
await fetchApi(api.groupDelete, { path: groupPath })
await fetchApi(api.personDelete, { path: personPath })
console.log('WP5 mock HTTP smoke passed for access endpoints, shared schemas, and member isolation.')
