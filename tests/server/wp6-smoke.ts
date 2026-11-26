import assert from 'node:assert/strict'
import type { z } from 'zod'
import { api } from '../../shared/api'
import { SetupStatus } from '../../shared/schemas/auth'
import { GuestWifi, KioskPayload, PoePort, PoeWatchdog, Rule, WolTarget } from '../../shared/schemas/automation'
import { NotificationChannel } from '../../shared/schemas/system'

const origin = process.argv[2] ?? 'http://127.0.0.1:3877'
const admin = { username: 'wp6-smoke-admin', displayName: 'Smoke admin', password: 'WP6 development test only' }
let cookie = ''
let checked = 0

async function request(endpoint: { path: string, method: string, output: z.ZodType }, options: {
  path?: string, body?: unknown, status?: number, session?: boolean
} = {}) {
  const { path = endpoint.path, body, status = 200, session = true } = options
  const response = await fetch(new URL(path, origin), { method: endpoint.method, signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(session && cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith('unifire-session='))
  if (sessionCookie && session) cookie = sessionCookie.split(';')[0]!
  assert.equal(response.status, status, `${endpoint.method} ${endpoint.path} returned ${response.status}`)
  const data: unknown = await response.json()
  checked++
  return status === 200 ? endpoint.output.parse(data) : data
}

const setup = SetupStatus.parse(await request(api.setupStatus))
assert.equal(setup.mock, true)
await request(setup.needsAdmin ? api.setupAdmin : api.login, { body: admin })
assert.ok(cookie)

await request(api.channels, { status: 401, session: false })
const channels = NotificationChannel.array().parse(await request(api.channels))
const webpush = channels.find(channel => channel.config.type === 'webpush')!
assert.ok(webpush)
const channel = NotificationChannel.parse(await request(api.channelCreate, { body: {
  name: 'Smoke webhook', enabled: true, config: { type: 'webhook', url: 'http://127.0.0.1/unifire-demo-echo', secret: 'smoke-fixture' },
  events: ['rule'],
} }))
const channelPath = `/api/notifications/channels/${channel.id}`
assert.deepEqual(channel.config, { type: 'webhook', url: '••••echo', secret: '••••ture', method: 'POST' })
await request(api.channelUpdate, { path: channelPath, body: { name: 'Edited webhook', config: channel.config } })
await request(api.channelTest, { path: `${channelPath}/test` })
assert.ok(NotificationChannel.array().parse(await request(api.channels)).find(row => row.id === channel.id)?.lastSentAt)
await request(api.channelDelete, { path: channelPath })
assert.deepEqual(await request(api.vapidKey), await request(api.vapidKey))
const endpoint = 'https://push.example.test/wp6-smoke'
await request(api.pushSubscribe, { body: { endpoint, keys: { auth: 'mock-auth', p256dh: 'mock-key' } } })
await request(api.channelTest, { path: `/api/notifications/channels/${webpush.id}/test` })
await request(api.pushUnsubscribe, { body: { endpoint } })
await request(api.pushAction, { path: '/api/push/action?token=invalid', body: { token: 'invalid' }, status: 403, session: false })

const rules = Rule.array().parse(await request(api.rules))
assert.ok(rules.length >= 3)
const rule = Rule.parse(await request(api.ruleCreate, { body: {
  name: 'Smoke test', description: null, enabled: false, trigger: { type: 'client.new' },
  conditions: [], actions: [{ type: 'delay', seconds: 1 }], cooldownSeconds: 3,
} }))
const rulePath = `/api/rules/${rule.id}`
await request(api.rule, { path: rulePath })
await request(api.ruleUpdate, { path: rulePath, body: { name: 'Smoke test edited' } })
await request(api.ruleTest, { path: `${rulePath}/test`, body: { dryRun: true } })
await request(api.ruleRuns, { path: `/api/rules/runs?ruleId=${rule.id}&limit=1` })
await request(api.ruleDelete, { path: rulePath })

const watchdogs = PoeWatchdog.array().parse(await request(api.watchdogs))
assert.ok(watchdogs.length >= 2)
const ports = PoePort.array().parse(await request(api.watchdogPorts))
const port = ports.find(port => watchdogs.every(row => row.switchMac !== port.switchMac || row.portIdx !== port.portIdx))!
assert.ok(port && port.poe && !port.isUplink)
const watchdog = PoeWatchdog.parse(await request(api.watchdogCreate, { body: {
  name: 'Smoke watchdog', targetMac: port.connectedClientMac, targetIp: '10.235.3.28', method: 'tcp', tcpPort: 554,
  intervalSec: 10, failThreshold: 2, cooldownMin: 15, maxCyclesPerDay: 2, switchMac: port.switchMac, portIdx: port.portIdx, enabled: false,
} }))
const watchdogPath = `/api/watchdogs/${watchdog.id}`
await request(api.watchdogUpdate, { path: watchdogPath, body: { name: 'Smoke watchdog edited' } })
await request(api.watchdogCycle, { path: `${watchdogPath}/cycle` })
await request(api.watchdogEvents, { path: `${watchdogPath}/events` })
await request(api.watchdogDelete, { path: watchdogPath })

await request(api.wlans)
const wifi = GuestWifi.parse(await request(api.guestWifi))
assert.ok(wifi.wlanId && wifi.kioskToken)
await request(api.guestWifiSave, { body: { wlanId: wifi.wlanId, enabled: wifi.enabled, rotation: wifi.rotation } })
const rotated = GuestWifi.parse(await request(api.guestWifiRotate))
assert.ok(rotated.lastRotatedAt)
const kiosk = `/api/kiosk/${wifi.kioskToken}`
const display = KioskPayload.parse(await request(api.kiosk, { path: kiosk, session: false }))
assert.equal(display.passphrase, rotated.passphrase)
const reset = GuestWifi.parse(await request(api.guestWifiKioskReset))
assert.notEqual(reset.kioskToken, wifi.kioskToken)
await request(api.kiosk, { path: kiosk, status: 404, session: false })

const targets = WolTarget.array().parse(await request(api.wolTargets))
assert.ok(targets.length >= 2)
const target = WolTarget.parse(await request(api.wolCreate, { body: {
  name: 'Smoke WoL', mac: targets[0]!.mac, broadcast: null, schedule: null,
} }))
const wolPath = `/api/wol/${target.id}`
assert.ok(target.effectiveBroadcast)
await request(api.wolUpdate, { path: wolPath, body: { port: 7 } })
const woken = WolTarget.parse(await request(api.wolWake, { path: `${wolPath}/wake` }))
assert.ok(woken.lastWokeAt)
await request(api.wolDelete, { path: wolPath })

console.log(`WP6 mock HTTP smoke passed (${checked} requests)`)
