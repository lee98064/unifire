import process from 'node:process'
import { DEFAULT_DATA_DIR, loadSessionPassword } from '../utils/keys'

// Loaded by Nitro's runtime config module before it resolves NUXT_* overrides.
// nuxt-auth-utils 0.6.2 derives its cookie key from appSecret.
export function initializeSessionKey() {
  if (import.meta.prerender) return
  const dataDir = process.env.NITRO_DATA_DIR || process.env.NUXT_DATA_DIR || DEFAULT_DATA_DIR
  const appSecret = process.env.NITRO_APP_SECRET || (
    process.env.NUXT_APP_SECRET_GENERATED === '1' ? undefined : process.env.NUXT_APP_SECRET
  )
  if (process.env.NUXT_SESSION_PASSWORD || !appSecret) {
    const secret = JSON.stringify(loadSessionPassword(dataDir))
    process.env.NUXT_APP_SECRET = secret
    if (process.env.NITRO_APP_SECRET) process.env.NITRO_APP_SECRET = secret
    delete process.env.NUXT_APP_SECRET_GENERATED
  }
}
