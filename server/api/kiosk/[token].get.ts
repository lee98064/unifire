import { defineEventHandler, getRequestIP, setResponseHeader } from 'h3'
import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { useAutomation } from '../../services/controller-runtime'
import { createLoginLimiter } from '../../services/login-limit'
import { apiError, readApiParams } from '../../utils/api-error'

const limiter = createLoginLimiter()

export default defineEventHandler(async event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  const { token } = await readApiParams(event, z.object({ token: Id.max(128) }))
  const ip = getRequestIP(event) ?? 'unknown'
  const retry = limiter.take(ip)
  if (retry) {
    setResponseHeader(event, 'Retry-After', Math.ceil(retry / 1000))
    throw apiError(429, 'KIOSK_RATE_LIMITED', 'errors.kioskRateLimited')
  }
  return (await useAutomation()).guestWifi.kiosk(token)
})
