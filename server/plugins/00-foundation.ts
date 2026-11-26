import { SessionUser } from '#shared/schemas/auth'
import { closeDb, initializeDb, useDb } from '../db'
import { startControllerRuntime } from '../services/controller-runtime'
import { liveBus } from '../utils/bus'
import { activeSessionUser } from '../utils/auth'
import { initializeCrypto } from '../utils/crypto'
import { closeEventStreams } from '../utils/event-streams'
import { loadEncryptionKey } from '../utils/keys'

export default defineNitroPlugin(nitro => {
  if (import.meta.prerender) return
  const config = useRuntimeConfig()
  const { dataDir, mockController } = config
  const levels: Record<string, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
  const level = levels[String(config.logLevel).toLowerCase()] ?? levels.info!
  const logError = () => { if (level >= 1) console.error('[unifire] Engine initialization failed. The lease loop will retry.') }
  initializeCrypto(loadEncryptionKey(dataDir))
  initializeDb(dataDir)
  sessionHooks.hook('fetch', session => {
    const row = activeSessionUser(session)
    if (row) session.user = SessionUser.parse(row)
    else delete session.user
  })
  const unsubscribe = level >= 2 ? liveBus.subscribe(event => {
    if (event.type === 'controller' && !event.data.connected && event.data.lastError) {
      console.warn('[unifire] Controller disconnected. Check the controller status in Settings.')
    }
  }) : undefined
  const controller = startControllerRuntime(useDb(), String(mockController) === 'true', import.meta.dev, logError)
  if (level >= 3) console.info('[unifire] Database ready.')
  // Nitro drains its HTTP listener before calling the close hook. End SSE before that drain.
  const signals: NodeJS.Signals[] = (process.env.NITRO_SHUTDOWN_SIGNALS ?? 'SIGTERM SIGINT').split(/\s+/)
    .filter((signal): signal is NodeJS.Signals => signal === 'SIGTERM' || signal === 'SIGINT')
  if (!import.meta.dev && !process.env.NITRO_SHUTDOWN_DISABLED) {
    for (const signal of new Set(signals)) process.prependListener(signal, closeEventStreams)
  }
  nitro.hooks.hook('close', async () => {
    for (const signal of signals) process.off(signal, closeEventStreams)
    closeEventStreams()
    unsubscribe?.()
    try { await (await controller)() } finally { closeDb() }
    if (level >= 4) console.debug('[unifire] Engine stopped and database closed.')
  })
})
