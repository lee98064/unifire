import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoeWatchdogInput, RuleInput, GuestWifiInput, WolTargetInput } from '#shared/schemas/automation'
import { NotificationChannelInput, PushPayload } from '#shared/schemas/system'
import { GroupInput, PersonInput, QuotaInput } from '#shared/schemas/access'
import { createDatabase } from '../../server/db'
import { auditEvents, clients, notificationChannels, pushSubscriptions, quotaRoutes, routeOverrides, settings, users } from '../../server/db/schema'
import { DAY, MINUTE, quotaPeriod } from '../../server/engine/access-time'
import { createGuestWifi, generateGuestPassphrase } from '../../server/engine/guest-wifi'
import { createManagedRoutes } from '../../server/engine/managed-routes'
import { createNotifier } from '../../server/engine/notifiers'
import { createQuotaRoutes } from '../../server/engine/quota-routes'
import { createRules, inRuleWindow, matchesTrigger } from '../../server/engine/rules'
import { createWatchdogs } from '../../server/engine/watchdogs'
import { createWol, magicPacket, subnetBroadcast } from '../../server/engine/wol'
import { createAccess } from '../../server/services/access'
import { createControllerService, systemContext, type ControllerService } from '../../server/services/controller'
import { createSettingsService } from '../../server/services/settings'
import { SWITCH_MAC } from '../../server/unifi/mock/fixtures'
import { initializeCrypto } from '../../server/utils/crypto'

const mac = '78:8a:20:10:00:09'
const monday = Date.parse('2026-11-23T15:00:00Z') // Monday 23:00 in Taipei
const VAPID_SETTING = 'notifications.vapid'
const translate = async (locale: string, key: string) => `${locale}:${key}`

describe('WP6 automation with fake transports', () => {
  let database: ReturnType<typeof createDatabase>
  let controller: ControllerService
  let access: ReturnType<typeof createAccess>
  let at: number

  beforeEach(async () => {
    at = monday
    database = createDatabase()
    initializeCrypto(Buffer.alloc(32, 6))
    controller = await createControllerService(database.db, { mock: true })
    await controller.ready()
    access = createAccess(database.db, controller, () => at)
  })

  afterEach(async () => {
    await controller?.stop()
    database?.sqlite.close()
  })

  function user(id: string, role: 'member' | 'admin', personId: string | null = null) {
    database.db.insert(users).values({ id, role, personId, username: id, displayName: id, locale: 'en',
      passwordHash: 'unused', createdAt: at }).run()
    return { id, authVersion: 0 }
  }

  const testProbe = async () => 5
  function channel(config: unknown, events: string[] = ['new_device']) {
    return NotificationChannelInput.parse({ config, name: 'Notifications', enabled: true, events })
  }

  it('masks encrypted channel data, preserves masked patches, and signs the exact webhook body', async () => {
    const captured: { url: string, body: string, signature: string | null }[] = []
    const notifier = createNotifier(database.db, access, { translate, now: () => at,
      http: async (url, init) => {
        captured.push({ url: String(url), body: String(init?.body), signature: new Headers(init?.headers).get('x-unifire-signature') })
        return new Response(null, { status: 204 })
      } })
    const row = notifier.channels.create(channel({ type: 'webhook', url: 'http://echo.example.test/callback', secret: 'fixture-secret' }))
    expect(row.config).toMatchObject({ url: '••••back', secret: '••••cret' })
    const raw = database.db.select().from(notificationChannels).where(eq(notificationChannels.id, row.id)).get()
    expect(raw?.encryptedConfig).not.toContain('fixture-secret')
    notifier.channels.update(row.id, { config: row.config, name: 'New name' })
    await notifier.notify({ event: 'new_device', data: { mac, x_passphrase: 'hidden' } })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ url: 'http://echo.example.test/callback',
      signature: `sha256=${createHmac('sha256', 'fixture-secret').update(captured[0]!.body).digest('hex')}` })
    expect(JSON.parse(captured[0]!.body)).toMatchObject({ event: 'new_device', ts: at, data: { mac, x_passphrase: '[redacted]' } })
    expect(notifier.channels.list()[0]).toMatchObject({ lastSentAt: at, lastError: null })
  })

  it('scopes push delivery, prunes stale subscriptions, and consumes signed tokens once before expiry', async () => {
    const { db } = database
    const admin = user('admin', 'admin')
    const person = access.people.rows()[0]!
    const member = user('member', 'member', person.id)
    const unrelated = user('other', 'member', access.people.rows()[1]!.id)
    const messages: { endpoint: string, payload: ReturnType<typeof PushPayload.parse> }[] = []
    const notifier = createNotifier(db, access, { translate, now: () => at, push: async (subscription, payload) => {
      if (subscription.endpoint.endsWith('/gone')) throw Object.assign(new Error('Fixture gone'), { statusCode: 410 })
      messages.push({ endpoint: subscription.endpoint, payload: PushPayload.parse(JSON.parse(String(payload))) })
      return { statusCode: 201, body: '', headers: {} }
    } })
    const { push } = notifier
    const subscribe = (id: string, name = id) => push.subscribe(id, {
      endpoint: `https://push.example.test/${name}`, keys: { p256dh: 'fake', auth: 'fake' },
    })
    for (const { id } of [admin, member, unrelated]) subscribe(id)
    subscribe(admin.id, 'gone')
    expect(() => push.subscribe(admin.id, { endpoint: 'https://127.0.0.1/private', keys: { auth: 'x', p256dh: 'x' } })).toThrow()
    const publicKey = push.publicKey().publicKey
    expect(publicKey).toBe(push.publicKey().publicKey)
    expect(db.select().from(settings).where(eq(settings.key, VAPID_SETTING)).get()?.value).not.toContain(publicKey)
    notifier.channels.create(channel({ type: 'webpush' }, ['route_drift', 'quota_warning', 'extension_request']))
    await notifier.notify({ event: 'route_drift', data: { managedRouteId: 'demo-managed-kids' } })
    expect(db.select().from(pushSubscriptions).all()).toHaveLength(3)
    expect(messages.map(message => message.endpoint)).toEqual(['https://push.example.test/admin'])
    expect(messages[0]?.payload).toMatchObject({ url: '/routes/demo-managed-kids', badgeCount: expect.any(Number),
      actions: [{ action: 'open', endpoint: expect.stringMatching(/^\/api\/push\/action\?token=/) }] })
    const token = messages[0]!.payload.actions[0]!.endpoint.split('=')[1]!
    const results = await Promise.allSettled([push.execute(token), push.execute(token)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(db.select().from(auditEvents).where(eq(auditEvents.action, 'push.routeOpened')).get()).toMatchObject({ actorId: admin.id })
    const expired = push.mint(admin, { type: 'open', managedRouteId: 'demo-managed-kids' })
    at += DAY
    await expect(push.execute(expired)).rejects.toMatchObject({ statusCode: 403 })
    await notifier.notify({ event: 'quota_warning', member: { personId: person.id } })
    await notifier.notify({ event: 'extension_request', variant: 'extension_decided', member: { personId: person.id } })
    expect(messages.slice(1).map(message => [message.endpoint, message.payload.actions.length, message.payload.badgeCount]))
      .toEqual([['https://push.example.test/member', 0, 0], ['https://push.example.test/member', 0, 0]])
  })

  it('ignores Telegram callbacks from the wrong chat and binds actions to the polling audience', async () => {
    const admin = user('telegram-admin', 'admin')
    const calls: { method: string, body: Record<string, unknown> }[] = []
    const notifier = createNotifier(database.db, access, { translate, mock: true, now: () => at, http: async (url, init) => {
      calls.push({ method: new URL(String(url)).pathname.split('/').at(-1)!, body: JSON.parse(String(init?.body)) })
      return Response.json({ ok: true })
    } })
    const botToken = '123456:fake_telegram_token'
    notifier.channels.create(channel({ type: 'telegram', botToken, chatId: '-42', interactive: true }, ['route_drift']))
    const stop = notifier.start(() => true)
    try {
      await notifier.notify({ event: 'route_drift', data: { managedRouteId: 'demo-managed-kids' } })
      const send = calls[0]
      expect(send).toMatchObject({ method: 'sendMessage', body: { parse_mode: 'HTML', chat_id: '-42' } })
      const { inline_keyboard } = send!.body.reply_markup as { inline_keyboard: [{ callback_data: string }[]] }
      const token = inline_keyboard[0][0]!.callback_data
      expect(token.length).toBeLessThanOrEqual(64)
      await expect(notifier.push.execute(token)).rejects.toMatchObject({ statusCode: 403 })
      const callback = (id: number) => ({ id: 'test', data: token, message: { chat: { id }, message_id: 15, text: 'Example' } })
      expect(await notifier.telegram.callback(botToken, callback(-43))).toBe(false)
      expect(calls.map(call => call.method)).toEqual(['sendMessage'])
      expect(await notifier.telegram.callback(botToken, callback(-42))).toBe(true)
      expect(calls.map(call => call.method)).toEqual(['sendMessage', 'answerCallbackQuery', 'editMessageText'])
      expect(database.db.select().from(auditEvents).where(eq(auditEvents.action, 'push.routeOpened')).get()).toMatchObject({ actorId: admin.id })
    } finally { await stop() }
  })

  it('uses one long poll per Telegram bot and encodes Discord and ntfy deliveries', async () => {
    user('transport-admin', 'admin')
    createSettingsService(database.db).patch({ siteUrl: 'https://unifire.example.test' })
    const requests: { url: string, init?: RequestInit }[] = []
    const notifier = createNotifier(database.db, access, { translate, now: () => at,
      http: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url.endsWith('/getUpdates')) {
          return new Promise((resolve, reject) => {
            if (init?.signal?.aborted) return reject(init.signal.reason)
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          })
        }
        return new Response(null, { status: 204 })
      } })
    notifier.channels.create(channel({ type: 'telegram', botToken: '1234:fixture_bot', chatId: '-42' }, []))
    notifier.channels.create(channel({ type: 'telegram', botToken: '1234:fixture_bot', chatId: '-98' }, []))
    notifier.channels.create(channel({ type: 'discord', webhookUrl: 'https://discord.example.test/webhook' }, ['egress_down']))
    notifier.channels.create(channel({ type: 'ntfy', server: 'https://ntfy.example.test', token: 'fixture-token', topic: 'unifire' }, ['route_drift']))
    const stop = notifier.start(() => true)
    try {
      expect(requests.filter(request => request.url.endsWith('/getUpdates'))).toHaveLength(1)
      await notifier.notify({ event: 'egress_down', data: { egressId: 'demo-vpn-4' } })
      const discord = requests.find(request => request.url.includes('discord.example.test'))!
      expect(JSON.parse(String(discord.init?.body))).toMatchObject({ allowed_mentions: { parse: [] },
        embeds: [{ title: 'en:notification.egress_down.title', color: 0xf03a3e }] })
      await notifier.notify({ event: 'route_drift', data: { managedRouteId: 'demo-managed-kids' } })
      const ntfy = requests.find(request => request.url === 'https://ntfy.example.test/unifire')!
      const headers = new Headers(ntfy.init?.headers)
      expect(headers.get('authorization')).toBe('Bearer fixture-token')
      expect(headers.get('priority')).toBe('4')
      const [button] = JSON.parse(headers.get('actions')!)
      expect(button).toMatchObject({ action: 'http', method: 'POST',
        url: expect.stringMatching(/^https:\/\/unifire\.example\.test\/api\/push\/action\?token=/) })
      await expect(notifier.push.execute(JSON.parse(button.body).token)).resolves.toEqual({ ok: true })
    } finally {
      await stop()
    }
  })

  it('filters before conditions, handles midnight, applies cooldown, and continues after a failure', async () => {
    const { db } = database
    const notify = createNotifier(db, access, { translate, mock: true })
    const wol = createWol(db, controller)
    const watchdogs = createWatchdogs(db, controller, notify.notify, { probe: testProbe })
    const fakeHttp = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const rules = createRules(db, controller, { access, notifications: notify, wol, watchdogs,
      managed: createManagedRoutes(db, controller, () => at) }, { now: () => at, http: fakeHttp })
    const person = access.people.rows()[0]!
    const rule = rules.create(RuleInput.parse({
      name: 'Curfew', description: null, enabled: true,
      cooldownSeconds: 60, trigger: { type: 'client.connected', macs: [person.deviceMacs[0]!], personId: person.id },
      conditions: [{ type: 'time', days: [0], start: '22:00', end: '02:00' }],
      actions: [
        { type: 'wol', targetId: 'missing' },
        { type: 'pause', personId: person.id, minutes: 60 },
        { type: 'webhook', url: 'http://echo.example.test', headers: { Authorization: 'Bearer fixture' },
          body: '{"name":"{{name}}","event":{{event}}}' },
      ],
    }))
    expect(rule.actions[2]).toMatchObject({ headers: { Authorization: '[redacted]' } })
    rules.update(rule.id, { actions: rule.actions })
    const event = { type: 'client.connected', mac: person.deviceMacs[0]! }
    expect(matchesTrigger(rule.trigger, { ...event, personId: 'different' })).toBe(false)
    expect(await rules.dispatch({ ...event, mac })).toEqual([])
    at += 2 * 60 * MINUTE // Tuesday 01:00, covered by Monday's window
    expect(inRuleWindow({ type: 'time', days: [0], start: '22:00', end: '02:00' }, at, 'Asia/Taipei')).toBe(true)
    const results = await rules.dispatch(event)
    expect(results[0]).toMatchObject({ ok: false, results: [{ ok: false }, { ok: true }, { ok: true }] })
    expect(access.people.get(person.id).pause.active).toBe(true)
    const [, request] = fakeHttp.mock.calls[0]!
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer fixture')
    expect(JSON.parse(String(request?.body))).toMatchObject({ event: { mac: event.mac, personId: person.id } })
    expect((await rules.dispatch(event))[0]?.skipped).toBe('cooldown')
    at += 60 * MINUTE
    expect((await rules.dispatch(event))[0]?.skipped).toBe('conditions')
    await controller.setMode('dry-run', systemContext)
    access.people.pause(person.id, null)
    const preview = await rules.test(rule.id, false)
    expect(preview).toMatchObject({ dryRun: true, results: [{ message: 'rule.result.would' }, { message: 'rule.result.would' }, { ok: true }] })
    expect(access.people.get(person.id).pause.active).toBe(false)
    await rules.test(rule.id, true)
    expect(fakeHttp).toHaveBeenCalledTimes(2)
    expect(rules.get(rule.id).runCount).toBe(1)
    const first = rules.page({ ruleId: rule.id, limit: 2 })
    expect(first.nextCursor).toBeTruthy()
    expect(new Set([...first.items, ...rules.page({ ruleId: rule.id, limit: 10, cursor: first.nextCursor! }).items].map(row => row.id)).size).toBe(5)
    at += 31 * DAY
    rules.tick()
    expect(rules.page({ limit: 50 }).items).toEqual([])
  })

  it('pauses and resumes a whole group, including members added after the rule was written', async () => {
    const { db } = database
    const notify = createNotifier(db, access, { translate, mock: true })
    const wol = createWol(db, controller)
    const watchdogs = createWatchdogs(db, controller, notify.notify, { probe: testProbe })
    const rules = createRules(db, controller, { access, notifications: notify, wol, watchdogs,
      managed: createManagedRoutes(db, controller, () => at) }, { now: () => at, http: vi.fn<typeof fetch>() })
    const [first, second] = access.people.rows()
    const group = access.people.groupCreate(GroupInput.parse({ name: 'Rule group', color: '#8E59FF', personIds: [first!.id] }))
    const pause = rules.create(RuleInput.parse({ name: 'Group curfew', description: null, enabled: true, cooldownSeconds: 0,
      trigger: { type: 'schedule', cron: '0 22 * * *' }, conditions: [], actions: [{ type: 'group.pause', groupId: group.id, minutes: 30 }] }))
    // Membership changes after the rule exists are honoured at run time.
    access.people.groupUpdate(group.id, { personIds: [first!.id, second!.id] })
    expect((await rules.test(pause.id, false)).results).toMatchObject([{ ok: true }])
    expect(access.people.get(first!.id).pause.active).toBe(true)
    expect(access.people.get(second!.id).pause.active).toBe(true)
    const resume = rules.create(RuleInput.parse({ name: 'Group morning', description: null, enabled: true, cooldownSeconds: 0,
      trigger: { type: 'schedule', cron: '0 7 * * *' }, conditions: [], actions: [{ type: 'group.resume', groupId: group.id }] }))
    await rules.test(resume.id, false)
    expect(access.people.get(first!.id).pause.active).toBe(false)
    expect(access.people.get(second!.id).pause.active).toBe(false)
  })

  it('fires level triggers from last-seen and sliding usage data once per threshold crossing', async () => {
    const { db } = database
    at = Date.now()
    const notifier = createNotifier(db, access, { translate, mock: true })
    const rules = createRules(db, controller, { access, notifications: notifier, wol: createWol(db, controller),
      watchdogs: createWatchdogs(db, controller, notifier.notify),
      managed: createManagedRoutes(db, controller, () => at) }, { now: () => at })
    const offline = controller.runtime!.cache.snapshot().knownClients.find(client =>
      !controller.runtime!.cache.snapshot().activeClients.some(station => station.mac === client.mac) && client.last_seen)!
    const baseline = { description: null, enabled: true, cooldownSeconds: 0, conditions: [],
      actions: [{ type: 'notify', title: '{{name}}', body: '{{bytes}}' }] }
    const lost = rules.create(RuleInput.parse({ ...baseline, name: 'Offline',
      trigger: { type: 'device.offline', mac: offline.mac, minutes: 5 } }))
    const traffic = rules.create(RuleInput.parse({ ...baseline, name: 'Traffic',
      trigger: { type: 'traffic.threshold', scope: { type: 'client', id: mac }, bytes: 200, windowMinutes: 5 } }))
    const sampled = Math.floor(at / MINUTE) * MINUTE
    access.usage.record([{ mac, ts: sampled - MINUTE, rxBytes: 175, txBytes: 25, active: true }], 'Asia/Taipei')
    rules.tick()
    await vi.waitFor(() => {
      expect(rules.get(lost.id).runCount).toBe(1)
      expect(rules.get(traffic.id).runCount).toBe(1)
    })
    rules.tick()
    expect(rules.page({ limit: 20 }).items).toHaveLength(2)
    at += 10 * MINUTE
    rules.tick()
    access.usage.record([{ mac, ts: sampled + 9 * MINUTE, rxBytes: 210, txBytes: 0, active: true }], 'Asia/Taipei')
    rules.tick()
    await vi.waitFor(() => expect(rules.get(traffic.id).runCount).toBe(2))
  })

  it('enforces watchdog thresholds, cooldown, uplink refusal, local-midnight limits and recovery', async () => {
    const notify = vi.fn(async () => {})
    let latency: number | null = null
    const watchdogs = createWatchdogs(database.db, controller, notify, { probe: async () => latency, now: () => at })
    const input = PoeWatchdogInput.parse({ name: 'Camera', targetMac: mac, targetIp: '10.235.3.28',
      method: 'icmp', tcpPort: null, intervalSec: 10, failThreshold: 2, cooldownMin: 1, maxCyclesPerDay: 1,
      switchMac: SWITCH_MAC, portIdx: 11, enabled: true })
    const port = (await watchdogs.ports()).find(row => row.portIdx === 11)
    expect(port).toMatchObject({ poe: true, isUplink: false, connectedClientMac: mac })
    expect((await watchdogs.ports()).some(row => row.portIdx === 24)).toBe(false)
    await expect(watchdogs.cyclePort(SWITCH_MAC, 24, systemContext)).rejects.toMatchObject({ code: 'UNSAFE_POE_PORT' })
    const { id } = await watchdogs.create(input)
    await watchdogs.check(id)
    expect(watchdogs.list()[0]?.state.status).toBe('failing')
    await watchdogs.check(id)
    expect(watchdogs.list()[0]?.state).toMatchObject({ status: 'cooldown', cyclesToday: 1 })
    expect(notify).toHaveBeenCalledOnce()
    at += 2 * MINUTE
    await watchdogs.check(id)
    expect(watchdogs.list()[0]?.state.status).toBe('limit')
    await expect(watchdogs.cycle(id, systemContext)).rejects.toMatchObject({ statusCode: 409 })
    at = quotaPeriod(at, 'Asia/Taipei', 'daily').end
    expect(watchdogs.list()[0]?.state.cyclesToday).toBe(0)
    latency = 4
    await watchdogs.check(id)
    expect(watchdogs.list()[0]?.state).toMatchObject({ status: 'ok', lastLatencyMs: 4 })
    expect(watchdogs.events(id).map(row => row.kind)).toEqual(expect.arrayContaining(['fail', 'cycle', 'limit', 'recovered']))
  })

  it('rotates only the WLAN passphrase, protects the kiosk token, and preserves dry-run state', async () => {
    for (let size = 8; size <= 63; size++) {
      expect(generateGuestPassphrase('digits', size)).toMatch(new RegExp(`^\\d{${size}}$`))
      const words = generateGuestPassphrase('words', size)
      expect(words).toHaveLength(size)
      expect(words).toMatch(/^[a-z]{3,6}(?:-[a-z]{3,6})*\d\d$/)
      const random = generateGuestPassphrase('random', size)
      expect(random).toHaveLength(size)
      expect(random).not.toMatch(/[01ILOilo]/)
    }
    const { db } = database
    const wifi = createGuestWifi(db, controller, vi.fn(async () => {}), () => at)
    const id = 'demo-wlan-2'
    const wire = async () => (await controller.runtime!.api.wlan(id))[0]!
    const before = await wire()
    createSettingsService(db).patch({ siteUrl: 'https://unifire.example.test' })
    await wifi.save(GuestWifiInput.parse({ wlanId: id, enabled: true,
      rotation: { cron: '0 4 * * 1', timezone: 'Asia/Taipei', style: 'words', length: 24 } }))
    const token = (await wifi.resetToken()).kioskToken!
    expect(wifi.get()).toMatchObject({ kioskUrl: `https://unifire.example.test/kiosk/${token}`, nextRotationAt: expect.any(Number) })
    const rotated = await wifi.rotate(systemContext)
    expect(rotated.passphrase).toHaveLength(24)
    expect(await wire()).toEqual({ ...before, x_passphrase: rotated.passphrase })
    expect(wifi.kiosk(token).wifiUri).toBe(`WIFI:T:WPA;S:Guest;P:${rotated.passphrase};;`)
    await wifi.resetToken()
    expect(() => wifi.kiosk(token)).toThrow()
    await controller.setMode('dry-run', systemContext)
    at += MINUTE
    expect((await wifi.rotate(systemContext)).lastRotatedAt).toBe(rotated.lastRotatedAt)
    expect(await wire()).toEqual({ ...before, x_passphrase: rotated.passphrase })
  })

  it('constructs WoL packets and resolves target, settings and subnet broadcasts in order', async () => {
    const station = controller.runtime!.cache.snapshot().knownClients.find(row => row.mac === mac)!
    const send = vi.fn(async (_packet: Buffer, _port: number, _address: string) => {})
    const wol = createWol(database.db, controller, { send, now: () => at })
    const target = wol.create(WolTargetInput.parse({ name: 'Camera', mac, broadcast: null, schedule: null }))
    const derived = subnetBroadcast('10.235.3.1/24')
    expect(derived).toBe('10.235.3.255')
    expect(subnetBroadcast('192.168.24.34/27')).toBe('192.168.24.63')
    expect(subnetBroadcast('192.168.1.50/32')).toBeNull()
    expect(target.effectiveBroadcast).toBe(derived)
    createSettingsService(database.db).patch({ broadcastOverrides: { [station.network_id!]: '192.168.24.63' } })
    expect(wol.list()[0]?.effectiveBroadcast).toBe('192.168.24.63')
    wol.update(target.id, { broadcast: '192.168.0.255', port: 7 })
    expect((await wol.wake(target.id, systemContext)).lastWokeAt).toBe(at)
    const packet = magicPacket(mac)
    expect(packet.length).toBe(102)
    expect(packet.toString('hex')).toBe('ff'.repeat(6) + mac.replaceAll(':', '').repeat(16))
    expect(send).toHaveBeenCalledWith(packet, 7, '192.168.0.255')
    await controller.setMode('dry-run', systemContext)
    at += MINUTE
    expect((await wol.wake(target.id, systemContext)).lastWokeAt).not.toBe(at)
    expect(send).toHaveBeenCalledOnce()
  })

  it('uses a managed override for quota overlap and creates a quota route only for other MACs', async () => {
    const { db } = database
    at = Date.now() + 2 * DAY // Seeded historical usage ends before this test period.
    const start = quotaPeriod(at, 'Asia/Taipei', 'daily').start
    at = start + 60 * MINUTE
    const managed = createManagedRoutes(db, controller, () => at)
    const route = managed.get('demo-managed-kids')
    const managedMac = route.targets.find(target => target.type === 'CLIENT')?.mac
    expect(managedMac).toBeTruthy()
    const unshared = mac
    expect(route.targets.some(target => target.type === 'CLIENT' && target.mac === unshared)).toBe(false)
    const person = access.people.create(PersonInput.parse({ name: 'Limit test', color: '#123456', deviceMacs: [managedMac!, unshared] }))
    access.quotas.create(QuotaInput.parse({ name: 'Limit', scope: { type: 'person', id: person.id },
      metric: 'bytes', period: 'daily', limit: 1, weekdayLimits: null, action: { type: 'egress', egressId: 'demo-wan-3' }, enabled: true }))
    access.usage.record([{ mac: managedMac!, ts: at - MINUTE, rxBytes: 50, txBytes: 0, active: true }], 'Asia/Taipei')
    const turn = createQuotaRoutes(db, controller, () => at)
    await turn(access.quotaStatuses(), access.people.rows())
    const liveRoute = db.select().from(quotaRoutes).where(eq(quotaRoutes.subject, `person:${person.id}`)).get()
    const wire = (await controller.runtime!.api.routes()).find(doc => doc._id === liveRoute?.routeId)
    expect(wire?.target_devices).toEqual([{ type: 'CLIENT', client_mac: unshared }])
    const overrides = () => db.select().from(routeOverrides).where(eq(routeOverrides.managedRouteId, route.id)).all()
    expect(overrides()).toEqual([expect.objectContaining({ egressId: 'demo-wan-3', reason: 'rule',
      endsAt: quotaPeriod(at, 'Asia/Taipei', 'daily').end })])
    expect(managed.get(route.id).desired).toMatchObject({ egressId: 'demo-wan-3', reason: 'rule' })
    expect(db.select().from(auditEvents).where(eq(auditEvents.action, 'quota.routeOverlap')).get())
      .toMatchObject({ messageParams: { person: person.name, route: route.name } })
    await managed.override(route.id, { minutes: 5, egressId: 'demo-wan-1' }, systemContext)
    expect(managed.get(route.id).desired.egressId).toBe('demo-wan-1')
    await managed.override(route.id, null, systemContext)
    expect(managed.get(route.id).desired.egressId).toBe('demo-wan-3')
    at = quotaPeriod(at, 'Asia/Taipei', 'daily').end
    await turn(access.quotaStatuses(), access.people.rows())
    expect(overrides()).toHaveLength(0)
  })

  it('records the human-readable label and name in approval audit rows', async () => {
    const pending = database.db.select().from(clients).where(eq(clients.approval, 'pending')).get()!
    await access.approval(pending.mac, { decision: 'approve', alias: 'Family phone' }, systemContext)
    expect(database.db.select().from(auditEvents).where(eq(auditEvents.action, 'approval.decided')).get())
      .toMatchObject({ target: { label: 'Family phone' }, messageParams: { mac: pending.mac, name: 'Family phone' } })
  })
})
