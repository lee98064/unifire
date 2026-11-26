import { createHmac } from 'node:crypto'
import { and, asc, count, eq } from 'drizzle-orm'
import type { PushPayloadT, NotificationEventT } from '#shared/schemas/system'
import type { Db } from '../../db'
import { clients, egresses, extensionRequests, managedRoutes, people, quotas, users } from '../../db/schema'
import type { createAccess } from '../../services/access'
import { createSettingsService } from '../../services/settings'
import { apiError } from '../../utils/api-error'
import { translate } from '../../utils/i18n'
import { redactSecrets } from '../../utils/redact'
import { createChannels, httpUrl } from './channels'
import { createPush, type NotificationAction, type PushTransport } from './push'
import { createTelegram, html, telegramAudience, type HttpTransport } from './telegram'

export type Notification = {
  event: NotificationEventT
  data?: Record<string, unknown>
  message?: { title: string, body: string }
  member?: { personId: string }
  variant?: 'extension_decided' | 'test'
}
const warning = new Set<NotificationEventT>(['new_device', 'route_drift', 'quota_warning', 'extension_request', 'poe_cycle', 'external_change'])
const error = new Set<NotificationEventT>(['egress_down', 'quota_exceeded', 'controller_error'])
const success = new Set<NotificationEventT>(['guest_wifi_rotated', 'egress_up'])
const actionPrefix = '/api/push/action?token='
const escapeHeader = (value: string) => /^[\x20-\x7e]+$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`

const mockHttp: HttpTransport = async () => Response.json({ ok: true, result: [] })
const mockPush: PushTransport = async () => ({ statusCode: 201, body: '', headers: {} })

export function createNotifier(db: Db, access: Pick<ReturnType<typeof createAccess>, 'approval' | 'extensions'>, options: {
  mock?: boolean
  http?: HttpTransport
  push?: PushTransport
  translate?: typeof translate
  now?: () => number
} = {}) {
  const http = options.http ?? (options.mock ? mockHttp : fetch)
  const push = createPush(db, access, { now: options.now, send: options.push ?? (options.mock ? mockPush : undefined) })
  const settings = createSettingsService(db)
  const now = options.now ?? Date.now
  const t = options.translate ?? translate
  const firstAdmin = () => db.select().from(users).where(eq(users.role, 'admin')).orderBy(asc(users.createdAt), asc(users.id)).get()
  const locale = () => firstAdmin()?.locale ?? 'zh-TW'
  const telegram = createTelegram(http, () => active?.() === false ? [] : channels.all(), (token, audiences) => {
    if (active?.() === false) throw apiError(503, 'UNIFI_INACTIVE', 'errors.unifiInactive')
    return push.execute(token, audiences)
  }, ok => t(locale(), ok ? 'notification.action.succeeded' : 'notification.action.failed'))
  const polling = new Map<string, { stop: AbortController, work: Promise<void> }>()
  const deliveries = new Map<string, Promise<unknown>>()
  let active: (() => boolean) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function syncPollers() {
    if (options.mock || !active) return
    const wanted = new Set(active() ? channels.all().flatMap(({ enabled, config }) =>
      enabled && config.type === 'telegram' && config.interactive ? [config.botToken] : []) : [])
    for (const [token, poller] of polling) if (!wanted.has(token)) poller.stop.abort()
    for (const token of wanted) {
      if (polling.has(token)) continue
      const stop = new AbortController()
      const work = telegram.poll(token, stop.signal).finally(() => { polling.delete(token) })
      polling.set(token, { stop, work })
    }
  }
  const channels = createChannels(db, syncPollers)

  function details(input: Notification) {
    const data = input.data ?? {}
    const string = (key: string) => {
      const value = data[key]
      return typeof value === 'string' ? value : undefined
    }
    const egressId = string('egressId')
    const routeId = string('managedRouteId')
    const personId = string('personId')
    const quotaId = string('quotaId')
    const egress = egressId && db.select({ name: egresses.name }).from(egresses).where(eq(egresses.id, egressId)).get()?.name
    const route = routeId && db.select({ name: managedRoutes.name }).from(managedRoutes).where(eq(managedRoutes.id, routeId)).get()?.name
    const person = personId && db.select({ name: people.name }).from(people).where(eq(people.id, personId)).get()?.name
    const quota = quotaId && db.select({ name: quotas.name }).from(quotas).where(eq(quotas.id, quotaId)).get()?.name
    const safeData = redactSecrets({ ...data, ...(egress && { egress }), ...(route && { route }), ...(person && { person }), ...(quota && { quota }) }) as Record<string, unknown>
    const params = Object.fromEntries(Object.entries(safeData).filter(([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').map(([key, value]) => [key, String(value)]))
    const url = input.member ? '/me' : input.event === 'new_device' || input.event === 'extension_request' ? '/approvals'
      : routeId ? `/routes/${encodeURIComponent(routeId)}` : egressId ? '/egresses' : '/'
    return { data: safeData, params, url }
  }

  function badgeCount(member: Notification['member'], testUser?: string) {
    if (member || testUser && db.select().from(users).where(eq(users.id, testUser)).get()?.role !== 'admin') return 0
    access.extensions.expire(now())
    const pending = db.select({ count: count() }).from(clients).where(eq(clients.approval, 'pending')).get()?.count ?? 0
    const requests = db.select({ count: count() }).from(extensionRequests).where(eq(extensionRequests.status, 'pending')).get()?.count ?? 0
    return pending + requests
  }

  async function buttons(input: Notification, admin: Parameters<typeof push.mint>[0], audience?: Parameters<typeof push.mint>[2]) {
    const data = input.data ?? {}
    let actions: [string, NotificationAction][] = []
    if (!input.variant && !input.member) {
      if (input.event === 'new_device' && typeof data.mac === 'string') actions = [
        ['approve', { type: 'approve_device', mac: data.mac }], ['block', { type: 'block_device', mac: data.mac }],
      ]
      if (input.event === 'extension_request' && typeof data.requestId === 'string') actions = [
        ['approve', { type: 'approve_extension', requestId: data.requestId }], ['deny', { type: 'deny_extension', requestId: data.requestId }],
      ]
      if (input.event === 'route_drift' && typeof data.managedRouteId === 'string') actions = [
        ['open', { type: 'open', managedRouteId: data.managedRouteId }],
      ]
    }
    return Promise.all(actions.map(async ([action, descriptor]) => ({
      action, title: await t(locale(), `notification.action.${action}`), endpoint: actionPrefix + push.mint(admin, descriptor, audience),
    })))
  }

  async function request(url: string, init: RequestInit) {
    const response = await http(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Notification HTTP request failed')
  }

  async function send(channel: ReturnType<typeof channels.get>, input: Notification, testUser?: string) {
    const config = channel.config
    const { data, params, url } = details(input)
    const language = locale()
    if (input.event === 'controller_error' && params.error) params.error = await t(language, params.error)
    const ts = now()
    const key = `notification.${input.variant ?? input.event}`
    const [title, body] = input.message ? [input.message.title, input.message.body]
      : await Promise.all([t(language, `${key}.title`, params), t(language, `${key}.body`, params)])
    const level = error.has(input.event) ? 3 : warning.has(input.event) ? 2 : success.has(input.event) ? 1 : 0
    const site = settings.get().siteUrl

    switch (config.type) {
      case 'webpush': {
        const recipients = push.recipients(input.member ?? null, testUser)
        const count = badgeCount(input.member, testUser)
        const candidate = site && URL.canParse(site) ? new URL(site) : null
        const subject = candidate?.protocol === 'https:' && candidate.hostname.includes('.') ? candidate.origin : 'mailto:unifire@localhost'
        const sent = await Promise.allSettled(recipients.map(async recipient => {
          const actions = recipient.user.role === 'admin' ? await buttons(input, recipient.user) : []
          const payload: PushPayloadT = { title, body, event: input.event, url, actions, badgeCount: count }
          return push.deliver(recipient, payload, subject)
        }))
        return {
          sent: sent.some(result => result.status === 'fulfilled' && result.value),
          failed: sent.some(result => result.status === 'rejected'),
        }
      }
      case 'telegram': {
        const admin = firstAdmin()
        const actions = config.interactive && admin ? await buttons(input, admin, telegramAudience(channel.id, config)) : []
        await telegram.call(config.botToken, 'sendMessage', {
          chat_id: config.chatId, text: `<b>${html(title)}</b>\n${html(body)}`, parse_mode: 'HTML',
          ...(actions.length && { reply_markup: { inline_keyboard: [actions.map(button => ({
            text: button.title, callback_data: button.endpoint.slice(actionPrefix.length),
          }))] } }),
        })
        break
      }
      case 'discord':
        await request(config.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowed_mentions: { parse: [] }, embeds: [{
            title: title.slice(0, 256), description: body.slice(0, 4096), color: [0x006fff, 0x38cc65, 0xf5a524, 0xf03a3e][level],
            timestamp: new Date(ts).toISOString(),
          }] }) })
        break
      case 'webhook': {
        const payload = JSON.stringify({ event: input.event, title, body, data, ts })
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (config.secret !== null) headers['X-Unifire-Signature'] = `sha256=${createHmac('sha256', config.secret).update(payload).digest('hex')}`
        await request(config.url, { method: config.method, headers, body: payload })
        break
      }
      case 'ntfy': {
        const endpoint = httpUrl(config.server)
        endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(config.topic)
        const headers: Record<string, string> = { Title: escapeHeader(title), Tags: ['bell', 'white_check_mark', 'warning', 'rotating_light'][level]!,
          Priority: level === 3 ? '5' : level === 2 ? '4' : '3', 'content-type': 'text/plain; charset=utf-8' }
        if (config.token) headers.Authorization = `Bearer ${config.token}`
        const admin = firstAdmin()
        if (site && admin) {
          const actions = await buttons(input, admin)
          if (actions.length) headers.Actions = JSON.stringify(actions.map(action => ({
            action: 'http', label: action.title, url: new URL(action.endpoint, httpUrl(site)).href, method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: action.endpoint.slice(actionPrefix.length) }),
          }))).replace(/[^\x20-\x7e]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
        }
        await request(endpoint.href, { method: 'POST', headers, body })
        break
      }
    }
    return { sent: true, failed: false }
  }

  function deliver(id: string, input: Notification, testUser?: string) {
    const task = (deliveries.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const channel = channels.get(id)
      if (active?.() === false || !testUser && !channel.enabled) return
      let result
      try { result = await send(channel, input, testUser) } catch { result = { failed: true, sent: false } }
      const errorKey = result.failed ? 'notification.delivery.failed' : testUser && !result.sent ? 'notification.delivery.noSubscription' : null
      channels.status(channel, errorKey, result.sent ? now() : undefined)
      if (errorKey) throw apiError(502, 'NOTIFICATION_DELIVERY_FAILED', errorKey)
    }).finally(() => { if (deliveries.get(id) === task) deliveries.delete(id) })
    deliveries.set(id, task)
    return task
  }

  async function notify(input: Notification, ids: string[] = [], requireSuccess = false) {
    const targets = channels.all().filter(row => row.enabled && (ids.length ? ids.includes(row.id) : row.events.includes(input.event)))
    const results = await Promise.allSettled(targets.map(row => deliver(row.id, input)))
    if (requireSuccess && results.some(result => result.status === 'rejected')) {
      throw apiError(502, 'NOTIFICATION_DELIVERY_FAILED', 'notification.delivery.failed')
    }
  }

  return {
    channels, push, notify, telegram,
    async test(id: string, userId: string) {
      await deliver(id, { event: 'rule', variant: 'test' }, userId)
      return { ok: true as const }
    },
    start(hasLease: () => boolean) {
      active = hasLease
      syncPollers()
      timer = setInterval(syncPollers, 5000)
      timer.unref()
      return async () => {
        active = () => false
        clearInterval(timer)
        for (const poller of polling.values()) poller.stop.abort()
        await Promise.allSettled([...Array.from(polling.values(), poller => poller.work), ...deliveries.values()])
      }
    },
  }
}
