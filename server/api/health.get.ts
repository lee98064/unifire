import { sql } from 'drizzle-orm'
import { defineEventHandler, setResponseHeader } from 'h3'
import { api } from '#shared/api'
import { useDb } from '../db'
import { savedController } from '../services/controller'
import { cachedControllerStatus } from '../services/controller-runtime'
import { apiError } from '../utils/api-error'

export default defineEventHandler(event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  let configured: boolean
  let connected: boolean
  try {
    const db = useDb()
    db.get(sql`SELECT 1`)
    const status = cachedControllerStatus()
    configured = status?.configured ?? (String(config.mockController) === 'true' || !!savedController(db))
    connected = status?.connected ?? false
  } catch {
    throw apiError(503, 'DATABASE_UNAVAILABLE', 'errors.databaseUnavailable')
  }
  return api.health.output.parse({
    ok: true, version: config.public.appVersion, uptimeSec: Math.floor(process.uptime()), db: 'ok',
    controller: connected ? 'connected' : configured ? 'disconnected' : 'unconfigured',
  })
})
