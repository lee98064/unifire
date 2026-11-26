import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { api as contract } from '../../shared/api'
import { SetupStatus, User } from '../../shared/schemas/auth'
import { Paged } from '../../shared/schemas/common'
import { AuditEvent } from '../../shared/schemas/insight'
import { LiveEvent, Settings } from '../../shared/schemas/system'

const api = {
  ...contract,
  setupStatus: { ...contract.setupStatus, output: SetupStatus },
  setupAdmin: { ...contract.setupAdmin, output: User },
  me: { ...contract.me, output: User },
  login: { ...contract.login, output: User },
  users: { ...contract.users, output: z.array(User) },
  userCreate: { ...contract.userCreate, output: User },
  userUpdate: { ...contract.userUpdate, output: User },
  settings: { ...contract.settings, output: Settings },
  settingsSave: { ...contract.settingsSave, output: Settings },
  audit: { ...contract.audit, output: Paged(AuditEvent) },
}

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3871').origin
const cookiePath = process.argv[3]
const testPassword = 'WP1 test password only'
const updatedPassword = 'WP1 updated test password only'
const adminName = 'wp1-smoke'
const verification = z.object({ verified: z.literal(true) })

class Client {
  constructor(public cookie = '') {}

  async request(method: string, url: string, body?: unknown) {
    const headers = new Headers({ Accept: 'application/json' })
    if (this.cookie) headers.set('Cookie', this.cookie)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const result = await fetch(origin + url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    const session = result.headers.getSetCookie().find(value => value.startsWith('unifire-session='))
    if (session) this.cookie = session.split(';')[0] ?? ''
    return result
  }

  async call<T>(endpoint: { method: string, path: string, output: z.ZodType<T> }, body?: unknown, path = endpoint.path) {
    const response = await this.request(endpoint.method, path, body)
    const json: unknown = await response.json()
    const error = z.object({ data: z.object({ code: z.string() }) }).safeParse(json)
    const code = error.success ? error.data.data.code : 'unknown code'
    assert.equal(response.status, 200, `${endpoint.method} ${path} returned ${response.status} (${code})`)
    return endpoint.output.parse(json)
  }

  async error(method: string, path: string, status: number, code: string, body?: unknown) {
    const response = await this.request(method, path, body)
    assert.equal(response.status, status, `${method} ${path}`)
    const error = z.object({ data: z.object({ code: z.literal(code) }) }).parse(await response.json())
    assert.equal(error.data.code, code)
    if (status === 429) assert.ok(Number(response.headers.get('Retry-After')) > 0)
  }
}

// Encode the small CBOR value set used by the software authenticator's attestation.
type Cbor = string | number | Buffer | Map<Cbor, Cbor>
function encode(value: Cbor): Buffer {
  function header(major: number, count: number) {
    if (count < 24) return Buffer.from([major << 5 | count])
    if (count < 256) return Buffer.from([major << 5 | 24, count])
    return Buffer.from([major << 5 | 25, count >> 8, count & 255])
  }
  if (typeof value === 'number') return value < 0 ? header(1, -1 - value) : header(0, value)
  if (typeof value === 'string') {
    const bytes = Buffer.from(value)
    return Buffer.concat([header(3, bytes.length), bytes])
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value])
  return Buffer.concat([header(5, value.size), ...Array.from(value).flatMap(([key, item]) => [encode(key), encode(item)])])
}

function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  assert.ok(jwk.x && jwk.y)
  const credential = randomBytes(32)
  const key = encode(new Map<Cbor, Cbor>([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]))
  const id = credential.toString('base64url')
  const envelope = { id, rawId: id, type: 'public-key', clientExtensionResults: {} }
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin }))
  const rpHash = (rp: string) => createHash('sha256').update(rp).digest()

  return {
    attest(rp: string, challenge: string) {
      const authData = Buffer.concat([
        rpHash(rp), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([0, credential.length]), credential, key,
      ])
      const attestation = encode(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
      return {
        ...envelope,
        response: {
          clientDataJSON: clientData('webauthn.create', challenge).toString('base64url'),
          attestationObject: attestation.toString('base64url'),
          transports: ['internal'],
        },
      }
    },
    assert(rp: string, challenge: string, userHandle: string) {
      const data = clientData('webauthn.get', challenge)
      const authenticatorData = Buffer.concat([rpHash(rp), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])])
      const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(data).digest()]), privateKey)
      return {
        ...envelope,
        response: {
          clientDataJSON: data.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'), userHandle,
        },
      }
    },
  }
}

async function connectEvents(client: Client) {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])
  const result = await fetch(origin + api.events.path, { headers: { Cookie: client.cookie }, signal })
  assert.equal(result.status, 200)
  assert.match(result.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.ok(result.body)
  const reader = result.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  async function frame() {
    while (!pending.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('SSE connection closed early')
      pending += chunk.value
    }
    const end = pending.indexOf('\n\n')
    const received = pending.slice(0, end)
    pending = pending.slice(end + 2)
    return received
  }
  function decode(raw: string) {
    const [type, data] = raw.split('\n')
    assert.ok(type && data && type.startsWith('event: ') && data.startsWith('data: '))
    return LiveEvent.parse({ type: type.slice(7), data: JSON.parse(data.slice(6)) })
  }
  assert.equal(decode(await frame()).type, 'hello')
  return { next: async () => decode(await frame()), frame, close: () => controller.abort() }
}

async function verifyRestart() {
  assert.ok(cookiePath)
  const saved = new Client(readFileSync(cookiePath, 'utf8'))
  const user = await saved.call(api.me)
  assert.equal(user.username, adminName)
  assert.equal(user.hasPasskey, true)
  assert.equal((await saved.call(api.settings)).timezone, 'UTC')
  console.log('Restart retained the sealed session, passkey, and settings.')
}

async function smoke() {
  const anonymous = new Client()
  assert.deepEqual(await anonymous.call(api.setupStatus), {
    needsAdmin: true, needsController: false, ready: false, mock: true, version: '0.1.0',
  })
  await anonymous.error('GET', api.me.path, 401, 'AUTH_REQUIRED')
  const admin = new Client()
  const setup = { username: adminName, displayName: 'WP1 Smoke', password: testPassword, locale: 'en' }
  const created = await admin.call(api.setupAdmin, setup)
  assert.equal(created.role, 'admin')
  assert.ok(admin.cookie.length > 'unifire-session='.length)
  assert.equal((await admin.call(api.me)).id, created.id)
  assert.equal((await anonymous.call(api.setupStatus)).ready, true)
  await anonymous.error('POST', api.setupAdmin.path, 409, 'SETUP_COMPLETE', setup)
  const idPath = api.userUpdate.path.replace(':id', created.id)
  await admin.error('PATCH', idPath, 409, 'LAST_ADMIN', { role: 'member' })
  await admin.error('DELETE', idPath, 409, 'LAST_ADMIN')
  await admin.call(api.logout)
  await admin.error('GET', api.me.path, 401, 'AUTH_REQUIRED')
  const credentials = { username: adminName.toUpperCase(), password: testPassword }
  assert.equal((await admin.call(api.login, credentials)).id, created.id)
  await anonymous.error('POST', api.login.path, 401, 'INVALID_CREDENTIALS', { ...credentials, password: 'wrong' })

  const initialSettings = await admin.call(api.settings)
  assert.equal(initialSettings.timezone, 'Asia/Taipei')
  assert.equal(initialSettings.probe.ipPool.length, 16)
  const adminEvents = await connectEvents(admin)
  try {
    await admin.error('PATCH', api.settingsSave.path, 400, 'INVALID_TIMEZONE', { timezone: 'Invalid/Zone' })
    assert.equal((await admin.call(api.settingsSave, { timezone: 'UTC' })).timezone, 'UTC')
    const event = await adminEvents.next()
    assert.equal(event.type, 'audit')
    if (event.type === 'audit') assert.equal(event.data.messageKey, 'audit.config.settingsChanged')
  } finally {
    adminEvents.close()
  }

  const memberName = 'smoke-member'
  const member = await admin.call(api.userCreate, {
    username: memberName, displayName: 'Test Member', password: testPassword, role: 'member', locale: 'en',
  })
  const memberPath = api.userUpdate.path.replace(':id', member.id)
  const previous = new Client(admin.cookie)
  await admin.call(api.changePassword, { currentPassword: testPassword, newPassword: updatedPassword })
  await previous.error('GET', api.me.path, 401, 'AUTH_REQUIRED')
  assert.equal((await admin.call(api.userUpdate, { displayName: 'Renamed Member' }, memberPath)).locale, 'en')
  assert.equal((await admin.call(api.users)).length, 2)

  const memberClient = new Client()
  await memberClient.call(api.login, { username: memberName, password: testPassword })
  await memberClient.error('GET', api.settings.path, 403, 'FORBIDDEN')
  await memberClient.error('GET', api.audit.path, 403, 'FORBIDDEN')
  const memberEvents = await connectEvents(memberClient)
  try {
    await admin.call(api.settingsSave, { presence: { graceMinutes: 12 } })
    assert.equal(await memberEvents.frame(), ': heartbeat')
  } finally {
    memberEvents.close()
  }
  await admin.call(api.userDelete, undefined, memberPath)
  await memberClient.error('GET', api.me.path, 401, 'AUTH_REQUIRED')

  const register = '/api/auth/webauthn/register'
  const authenticate = '/api/auth/webauthn/authenticate'
  const key = authenticator()
  const identity = { userName: 'ignored-client-name' }
  const optionsBody = { verify: false, user: identity }
  await anonymous.error('POST', register, 401, 'AUTH_REQUIRED', optionsBody)
  const registration = await admin.call({
    method: 'POST', path: register,
    output: z.object({
      attemptId: z.string(),
      creationOptions: z.object({
        challenge: z.string(), rp: z.object({ id: z.string() }),
        user: z.object({ id: z.string(), name: z.string() }),
      }),
    }),
  }, optionsBody)
  const creation = registration.creationOptions
  assert.equal(creation.user.name, adminName)
  const attestation = {
    verify: true, user: identity, attemptId: registration.attemptId,
    response: key.attest(creation.rp.id, creation.challenge),
  }
  await admin.call({ method: 'POST', path: register, output: verification }, attestation)
  await admin.error('POST', register, 400, 'WEBAUTHN_CHALLENGE_INVALID', attestation)
  assert.equal((await admin.call(api.me)).hasPasskey, true)

  await admin.call(api.logout)
  const authentication = await admin.call({
    method: 'POST', path: authenticate,
    output: z.object({
      attemptId: z.string(),
      requestOptions: z.object({ challenge: z.string(), rpId: z.string() }),
    }),
  }, { verify: false, userName: adminName })
  const request = authentication.requestOptions
  const assertion = {
    verify: true, userName: adminName, attemptId: authentication.attemptId,
    response: key.assert(request.rpId, request.challenge, creation.user.id),
  }
  await admin.call({ method: 'POST', path: authenticate, output: verification }, assertion)
  await anonymous.error('POST', authenticate, 400, 'WEBAUTHN_CHALLENGE_INVALID', assertion)
  assert.equal((await admin.call(api.me)).id, created.id)

  const page = await admin.call(api.audit, undefined, '/api/audit?limit=2&category=auth&actor=user')
  assert.equal(page.items.length, 2)
  assert.ok(page.nextCursor)
  const next = await admin.call(api.audit, undefined, `/api/audit?limit=2&category=auth&actor=user&cursor=${page.nextCursor}`)
  assert.ok(next.items.every(item => !page.items.some(prior => prior.id === item.id)))
  await admin.error('GET', '/api/audit?cursor=malformed!', 400, 'INVALID_CURSOR')
  for (let index = 0; index < 5; index++) {
    await anonymous.error('POST', api.login.path, 401, 'INVALID_CREDENTIALS', { username: 'unregistered', password: 'wrong' })
  }
  await anonymous.error('POST', api.login.path, 429, 'LOGIN_RATE_LIMITED', { username: 'Unregistered', password: 'wrong' })

  if (cookiePath) writeFileSync(cookiePath, admin.cookie, { mode: 0o600 })
  console.log('WP1 live smoke passed for setup, sessions, users, settings, passkeys, audit, and SSE.')
}

await (process.argv.includes('--check-restart') ? verifyRestart() : smoke())
