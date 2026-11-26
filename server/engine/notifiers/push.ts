import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm'
import { generateVAPIDKeys, sendNotification } from 'web-push'
import { z } from 'zod'
import { Id, Mac } from '#shared/schemas/common'
import { PushPayload, type PushSubscriptionInput } from '#shared/schemas/system'
import type { Db } from '../../db'
import { clients, pushActionTokens, pushSubscriptions, settings, users } from '../../db/schema'
import type { createAccess } from '../../services/access'
import { createAuditService, userActor } from '../../services/audit'
import { apiError } from '../../utils/api-error'
import { decrypt, encrypt } from '../../utils/crypto'
import { DAY } from '../access-time'
import { publicPushHost, pushAgent } from './push-network'
import { httpUrl } from './channels'

const Action = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['approve_device', 'block_device']), mac: Mac }),
  z.object({ type: z.enum(['approve_extension', 'deny_extension']), requestId: Id }),
  z.object({ type: z.literal('open'), managedRouteId: Id }),
])
export type NotificationAction = z.infer<typeof Action>
const Audience = z.union([z.literal('push'), z.string().startsWith('telegram:')])
type AudienceT = z.infer<typeof Audience>
const TokenPayload = z.object({ action: Action, audience: Audience, authVersion: z.number().int() })
const Keys = z.object({ publicKey: z.string(), privateKey: z.string() })
const Stored = z.object({ keys: Keys, signingKey: z.string() })
export type PushTransport = typeof sendNotification
type Admin = Pick<typeof users.$inferSelect, 'id' | 'authVersion'>
const digest = (token: string) => createHash('sha256').update(token).digest()
const invalid = () => apiError(403, 'PUSH_ACTION_INVALID', 'errors.pushActionInvalid')
const key = 'notifications.vapid'
const subscriptionKey = (endpoint: string) => digest(endpoint).toString('hex')
const SubscriptionKeys = z.object({ p256dh: z.string(), auth: z.string() })
const EncryptedSubscription = SubscriptionKeys.extend({ endpoint: z.string().optional() })

export function createPush(db: Db, access: Pick<ReturnType<typeof createAccess>, 'approval' | 'extensions'>, options: {
  now?: () => number
  send?: PushTransport
} = {}) {
  const now = options.now ?? Date.now
  const send = options.send ?? sendNotification
  const audit = createAuditService(db)

  function stored() {
    const read = () => db.select().from(settings).where(eq(settings.key, key)).get()?.value
    let value = read()
    if (typeof value !== 'string') {
      db.insert(settings).values({ key, value: encrypt({
        keys: { ...generateVAPIDKeys() }, signingKey: randomBytes(32).toString('base64url'),
      }) }).onConflictDoNothing().run()
      value = read()
    }
    return Stored.parse(decrypt(z.string().parse(value)))
  }

  function mac(nonce: string) {
    // Keep the authenticated opaque token below Telegram's 64 byte callback limit.
    return createHmac('sha256', Buffer.from(stored().signingKey, 'base64url')).update(nonce).digest().subarray(0, 16)
  }

  function mint(admin: Admin, action: NotificationAction, audience: AudienceT = 'push') {
    const nonce = randomBytes(16).toString('base64url')
    const token = `${nonce}.${mac(nonce).toString('base64url')}`
    const at = now()
    db.delete(pushActionTokens).where(lte(pushActionTokens.expiresAt, at)).run()
    db.insert(pushActionTokens).values({ tokenHash: digest(token), userId: admin.id, action: action.type,
      payload: { action, audience, authVersion: admin.authVersion }, expiresAt: at + DAY }).run()
    return token
  }

  async function execute(token: string, audiences: AudienceT[] = ['push']) {
    if (!/^[\w-]{22}\.[\w-]{22}$/.test(token)) throw invalid()
    const [nonce, signature] = token.split('.') as [string, string]
    if (!timingSafeEqual(mac(nonce), Buffer.from(signature, 'base64url'))) throw invalid()
    const at = now()
    const eligible = and(eq(pushActionTokens.tokenHash, digest(token)), gt(pushActionTokens.expiresAt, at), isNull(pushActionTokens.usedAt))
    const { user, action } = db.transaction(tx => {
      const row = tx.select().from(pushActionTokens).where(eligible).get()
      if (!row?.userId) throw invalid()
      const payload = TokenPayload.safeParse(row.payload)
      if (!payload.success || !audiences.includes(payload.data.audience)) throw invalid()
      const user = tx.select().from(users).where(eq(users.id, row.userId)).get()
      if (!user || user.role !== 'admin' || user.authVersion !== payload.data.authVersion) throw invalid()
      if (!tx.update(pushActionTokens).set({ usedAt: at }).where(eligible).returning().get()) throw invalid()
      return { user, action: payload.data.action }
    }, { behavior: 'immediate' })
    if (action.type === 'approve_device' || action.type === 'block_device') {
      const client = db.select({ approval: clients.approval }).from(clients).where(eq(clients.mac, action.mac)).get()
      if (client?.approval !== 'pending') throw apiError(409, 'APPROVAL_NOT_PENDING', 'errors.approvalNotPending')
      await access.approval(action.mac, { decision: action.type === 'approve_device' ? 'approve' : 'block' }, { actor: userActor(user) })
    } else if (action.type === 'approve_extension' || action.type === 'deny_extension') {
      access.extensions.decide(action.requestId, { decision: action.type === 'approve_extension' ? 'approve' : 'deny' }, user)
    } else if (action.type === 'open') {
      audit.record({ actor: userActor(user), category: 'route', action: 'push.routeOpened', severity: 'info',
        target: { type: 'route', id: action.managedRouteId, label: action.managedRouteId }, messageKey: 'audit.push.routeOpened' })
    }
    return { ok: true as const }
  }

  function subscribe(userId: string, input: z.output<typeof PushSubscriptionInput>) {
    const url = httpUrl(input.endpoint)
    if (url.protocol !== 'https:' || !publicPushHost(url.hostname)) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
    const row = { userId, encryptedKeys: encrypt({ ...input.keys, endpoint: input.endpoint }), deviceLabel: input.deviceLabel ?? null, createdAt: now() }
    db.transaction(tx => {
      tx.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint)).run()
      tx.insert(pushSubscriptions).values({ ...row, endpoint: subscriptionKey(input.endpoint) })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row }).run()
    })
    return { ok: true as const }
  }

  function unsubscribe(userId: string, endpoint: string) {
    db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId),
      or(eq(pushSubscriptions.endpoint, subscriptionKey(endpoint)), eq(pushSubscriptions.endpoint, endpoint)))).run()
    return { ok: true as const }
  }

  function recipients(scope: { personId: string } | null, userId?: string) {
    return db.select({ sub: pushSubscriptions, user: users }).from(pushSubscriptions)
      .innerJoin(users, eq(users.id, pushSubscriptions.userId)).where(userId ? eq(users.id, userId)
        : scope ? and(eq(users.role, 'member'), eq(users.personId, scope.personId))
          : eq(users.role, 'admin')).all()
  }

  async function deliver(recipient: ReturnType<typeof recipients>[number], payload: z.input<typeof PushPayload>, subject: string) {
    const { sub } = recipient
    const { endpoint = sub.endpoint, ...keys } = EncryptedSubscription.parse(decrypt(sub.encryptedKeys))
    const url = httpUrl(endpoint)
    if (url.protocol !== 'https:' || !publicPushHost(url.hostname)) throw new Error('Invalid push endpoint')
    try {
      await send({ endpoint, keys }, JSON.stringify(PushPayload.parse(payload)),
        { vapidDetails: { subject, ...stored().keys }, TTL: 86_400, timeout: 10_000, contentEncoding: 'aes128gcm', agent: pushAgent })
      return true
    } catch (error) {
      const status = z.object({ statusCode: z.number() }).safeParse(error).data?.statusCode
      if (status !== 404 && status !== 410) throw error
      db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, sub.endpoint),
        eq(pushSubscriptions.userId, sub.userId), eq(pushSubscriptions.encryptedKeys, sub.encryptedKeys))).run()
      return false
    }
  }

  return { mint, execute, subscribe, unsubscribe, recipients, deliver, publicKey: () => ({ publicKey: stored().keys.publicKey }) }
}
