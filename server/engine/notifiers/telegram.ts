import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { ChannelConfigT } from '#shared/schemas/system'

export type HttpTransport = typeof fetch
type Config = Extract<ChannelConfigT, { type: 'telegram' }>
type Channel = { id: string, enabled: boolean, config: ChannelConfigT }

const Chat = z.object({ id: z.number().int(), username: z.string().optional() })
const Callback = z.object({ id: z.string(), data: z.string(),
  message: z.object({ chat: Chat, message_id: z.number().int(), text: z.string().optional() }) })
const Updates = z.array(z.object({ update_id: z.number().int(), callback_query: z.unknown().optional() }))

export function html(value: string) {
  return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!)
}

export function telegramAudience(id: string, config: Config) {
  // Invalidate callbacks issued for a previous chat or bot, including after a config edit.
  return `telegram:${id}:${config.botToken.split(':')[0]}:${config.chatId.toLowerCase()}` as const
}

export function createTelegram(http: HttpTransport, channels: () => Channel[],
  execute: (token: string, audiences: ReturnType<typeof telegramAudience>[]) => Promise<unknown>,
  outcome: (ok: boolean) => Promise<string>) {
  async function call(botToken: string, method: string, body: object, signal?: AbortSignal, timeout = 10_000) {
    const deadline = AbortSignal.timeout(timeout)
    const response = await http(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error',
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Telegram HTTP request failed')
    }
    const { ok, result } = z.object({ ok: z.boolean(), result: z.unknown().optional() }).parse(await response.json())
    if (!ok) throw new Error('Telegram API request failed')
    return result
  }

  function matching(botToken: string) {
    return channels().flatMap(channel => {
      const { config } = channel
      return channel.enabled && config.type === 'telegram' && config.interactive && config.botToken === botToken
        ? [{ id: channel.id, config }] : []
    })
  }

  async function callback(botToken: string, value: unknown, signal?: AbortSignal) {
    const parsed = Callback.safeParse(value)
    if (!parsed.success) return false
    const { data, id, message } = parsed.data
    const audiences = matching(botToken).filter(({ config }) =>
      config.chatId.startsWith('@') ? config.chatId.toLowerCase() === `@${message.chat.username?.toLowerCase() ?? ''}`
        : config.chatId === String(message.chat.id)).map(({ id, config }) => telegramAudience(id, config))
    if (!audiences.length || signal?.aborted) return false
    let ok = false
    try { await execute(data, audiences); ok = true } catch { /* A stale or invalid action is shown as failed. */ }
    const result = await outcome(ok)
    await Promise.allSettled([
      call(botToken, 'answerCallbackQuery', { callback_query_id: id, text: result.slice(0, 200) }, signal),
      call(botToken, 'editMessageText', { chat_id: message.chat.id, message_id: message.message_id,
        text: `${html((message.text ?? '').slice(0, 3600))}\n\n<b>${html(result)}</b>`, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] } }, signal),
    ])
    return ok
  }

  async function poll(botToken: string, signal: AbortSignal) {
    let offset: number | undefined
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const updates = Updates.parse(await call(botToken, 'getUpdates',
          { offset, timeout: 25, allowed_updates: ['callback_query'] }, signal, 35_000))
        for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
          if (signal.aborted) break
          if (update.callback_query !== undefined) await callback(botToken, update.callback_query, signal)
          offset = update.update_id + 1
        }
        backoff = 1000
        if (!updates.length) await sleep(250, undefined, { signal, ref: false })
      } catch {
        await sleep(backoff, undefined, { signal, ref: false }).catch(() => {})
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  return { call, callback, poll }
}
