import { SessionUser } from '#shared/schemas/auth'
import { closeDb, initializeDb } from '../db'
import { activeSessionUser } from '../utils/auth'
import { initializeCrypto } from '../utils/crypto'
import { loadEncryptionKey } from '../utils/keys'

export default defineNitroPlugin(nitro => {
  if (import.meta.prerender) return
  const { dataDir } = useRuntimeConfig()
  initializeCrypto(loadEncryptionKey(dataDir))
  initializeDb(dataDir)
  nitro.hooks.hook('close', closeDb)
  sessionHooks.hook('fetch', session => {
    const row = activeSessionUser(session)
    if (row) session.user = SessionUser.parse(row)
    else delete session.user
  })
})
