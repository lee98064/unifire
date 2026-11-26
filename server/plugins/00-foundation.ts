import { SessionUser } from '#shared/schemas/auth'
import { closeDb, initializeDb, useDb } from '../db'
import { startControllerRuntime } from '../services/controller-runtime'
import { activeSessionUser } from '../utils/auth'
import { initializeCrypto } from '../utils/crypto'
import { loadEncryptionKey } from '../utils/keys'

export default defineNitroPlugin(nitro => {
  if (import.meta.prerender) return
  const { dataDir, mockController } = useRuntimeConfig()
  initializeCrypto(loadEncryptionKey(dataDir))
  initializeDb(dataDir)
  sessionHooks.hook('fetch', session => {
    const row = activeSessionUser(session)
    if (row) session.user = SessionUser.parse(row)
    else delete session.user
  })
  const controller = startControllerRuntime(useDb(), String(mockController) === 'true', import.meta.dev)
  void controller.catch(error => nitro.captureError(error, { tags: ['unifire.controller'] }))
  nitro.hooks.hook('close', async () => {
    try { await (await controller)() } finally { closeDb() }
  })
})
