import { z } from 'zod'
import type { LocaleT } from '#shared/schemas/auth'

export async function translate(locale: LocaleT, key: string, params: Record<string, string> = {}) {
  const messages = await useStorage('assets:locales').getItem(`${locale}.json`)
  let message: unknown = messages
  for (const segment of key.split('.')) {
    if (typeof message !== 'object' || message === null || !Object.hasOwn(message, segment)) return key
    message = (message as Record<string, unknown>)[segment]
  }
  const text = z.string().safeParse(message)
  return text.success
    ? text.data.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => params[name] ?? placeholder)
    : key
}
