import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ChannelConfig, NotificationChannel, NotificationChannelInput, type ChannelConfigT } from '#shared/schemas/system'
import type { Db } from '../../db'
import { notificationChannels as channels } from '../../db/schema'
import { apiError } from '../../utils/api-error'
import { decrypt, encrypt } from '../../utils/crypto'

export function httpUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  }
  return url
}

const maskPrefix = '••••'
const mask = (value: string | null) => value === null ? null : maskPrefix + (value.length > 4 ? value.slice(-4) : '')
const secret = (value: string, previous?: string | null) => {
  if (!value.startsWith(maskPrefix)) return value
  if (previous == null) throw apiError(400, 'INVALID_CHANNEL_SECRET', 'errors.invalidChannelSecret')
  return previous
}
const optionalSecret = (value: string | null, previous?: string | null) => value === null ? null : secret(value, previous)

function masked(config: ChannelConfigT): ChannelConfigT {
  switch (config.type) {
    case 'telegram': return { ...config, botToken: mask(config.botToken)! }
    case 'discord': return { ...config, webhookUrl: mask(config.webhookUrl)! }
    case 'webhook': return { ...config, url: mask(config.url)!, secret: mask(config.secret) }
    case 'ntfy': return { ...config, token: mask(config.token) }
    case 'webpush': return config
  }
}

function resolve(config: ChannelConfigT, previous?: ChannelConfigT): ChannelConfigT {
  switch (config.type) {
    case 'telegram': {
      const botToken = secret(config.botToken, previous?.type === 'telegram' ? previous.botToken : undefined)
      if (!/^\d+:[\w-]+$/.test(botToken) || !/^-?\d+$|^@[\w]+$/.test(config.chatId)) {
        throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
      }
      return { ...config, botToken }
    }
    case 'discord': {
      const webhookUrl = secret(config.webhookUrl, previous?.type === 'discord' ? previous.webhookUrl : undefined)
      httpUrl(webhookUrl)
      return { ...config, webhookUrl }
    }
    case 'webhook': {
      const old = previous?.type === 'webhook' ? previous : undefined
      const url = secret(config.url, old?.url)
      httpUrl(url)
      return { ...config, url, secret: optionalSecret(config.secret, old?.secret) }
    }
    case 'ntfy':
      httpUrl(config.server)
      if (!/^[\w-]+$/.test(config.topic)) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
      return { ...config, token: optionalSecret(config.token, previous?.type === 'ntfy' ? previous.token : undefined) }
    case 'webpush': return config
  }
}

type Input = z.output<typeof NotificationChannelInput>
export function createChannels(db: Db, changed = () => {}) {
  const open = ({ encryptedConfig, type: _type, ...row }: typeof channels.$inferSelect) =>
    ({ ...row, encryptedConfig, config: ChannelConfig.parse(decrypt(encryptedConfig)) })
  const view = (row: ReturnType<typeof open>) => NotificationChannel.parse({ ...row, config: masked(row.config) })
  function get(id: string) {
    const row = db.select().from(channels).where(eq(channels.id, id)).get()
    if (!row) throw apiError(404, 'CHANNEL_NOT_FOUND', 'errors.channelNotFound')
    return open(row)
  }
  function all() { return db.select().from(channels).orderBy(asc(channels.name), asc(channels.id)).all().map(open) }
  return {
    get, all,
    list: () => all().map(view),
    create(input: Input) {
      const { config: raw, ...fields } = input
      const config = resolve(raw)
      const row = db.insert(channels).values({ ...fields, id: randomUUID(), type: config.type, encryptedConfig: encrypt(config) }).returning().get()
      changed()
      return view(open(row))
    },
    update(id: string, input: Partial<Input>) {
      const current = get(id)
      const { config: raw, ...fields } = input
      const config = raw ? resolve(raw, current.config) : undefined
      const row = db.update(channels).set({ ...fields, ...(config && {
        type: config.type, encryptedConfig: encrypt(config), lastError: null,
      }) }).where(eq(channels.id, id)).returning().get()
      changed()
      return view(open(row))
    },
    delete(id: string) {
      get(id)
      db.delete(channels).where(eq(channels.id, id)).run()
      changed()
      return { ok: true as const }
    },
    status(channel: Pick<ReturnType<typeof open>, 'id' | 'encryptedConfig'>, lastError: string | null, lastSentAt?: number) {
      db.update(channels).set({ lastError, lastSentAt }).where(and(eq(channels.id, channel.id),
        eq(channels.encryptedConfig, channel.encryptedConfig))).run()
    },
  }
}
