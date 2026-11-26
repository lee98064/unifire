import { Agent, request } from 'undici'
import { z } from 'zod'
import type { ControllerInputT } from '#shared/schemas/controller'
import { UnifiError, unifiErrorCode } from './errors'
import { osPaths } from './paths'
import { controllerUrl, makeConnector } from './tls'

export type UnifiConfig = ControllerInputT & { password: string }
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
type Headers = Record<string, string | string[] | undefined>
type Cookie = { name: string, value: string, path: string, secure: boolean, expiresAt: number }

const envelope = z.object({ meta: z.object({ rc: z.string(), msg: z.string().optional() }), data: z.unknown().optional() })
const hasMeta = z.object({ meta: z.object({ rc: z.unknown() }) })
const loginRequired = z.object({ error: z.literal('api.err.LoginRequired') })
const loginRequiredCode = 'UNIFI_AUTH_REQUIRED'
const authStatuses = new Set([401, 403, 429])

function header(headers: Headers, name: string) {
  const value = headers[name]
  return Array.isArray(value) ? value.at(-1) : value
}

function transportError(error: unknown) {
  if (error instanceof UnifiError) return error
  const code = z.object({ code: z.string() }).safeParse(error).data?.code ?? ''
  if (code.includes('TIMEOUT') || (error instanceof Error && error.name === 'TimeoutError')) {
    return new UnifiError('UNIFI_TIMEOUT', undefined, { cause: error })
  }
  if (/CERT|TLS|SELF_SIGNED|ISSUER|LEAF_SIGNATURE/.test(code)) {
    return new UnifiError('UNIFI_TLS', undefined, { cause: error })
  }
  return new UnifiError('UNIFI_UNREACHABLE', undefined, { cause: error })
}

export function createUnifiTransport(config: UnifiConfig, options: {
  mock?: boolean
  now?: () => number
  random?: () => number
  authLocked?: boolean
  onAuthError?: (code: string | null) => void
  canLogin?: () => boolean
} = {}) {
  const origin = controllerUrl(config.url, options.mock)
  const paths = osPaths(config.site)
  let localIp: string | null = null
  const connect = makeConnector(config, address => { localIp = address ?? null })
  const dispatcher = new Agent({ connect, connections: 6 })
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const cookies = new Map<string, Cookie>()
  let csrf: string | undefined
  let generation = 0
  let session = false
  let loginInFlight: Promise<void> | undefined
  let failures = 0
  let authFailures = options.authLocked ? 3 : 0
  let retryAt = 0
  let lastError: string | null = options.authLocked ? 'UNIFI_AUTH_LOCKED' : null
  let closed = false
  let postQueue = Promise.resolve()

  function statusError(code: string | null) {
    if (code !== lastError) {
      lastError = code
      options.onAuthError?.(code)
    }
  }

  function acceptHeaders(headers: Headers, pathname: string, login: boolean, sentCsrf?: string) {
    const setCookies = headers['set-cookie']
    for (const item of typeof setCookies === 'string' ? [setCookies] : setCookies ?? []) {
      const [pair, ...attributes] = item.split(';')
      const eq = pair?.indexOf('=') ?? -1
      if (!pair || eq < 1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1)
      const fields = new Map(attributes.map(attribute => {
        const [key, ...parts] = attribute.trim().split('=')
        return [key?.toLowerCase(), parts.join('=')]
      }))
      const domain = fields.get('domain')?.toLowerCase().replace(/^\./, '')
      if (domain && origin.hostname !== domain && !origin.hostname.endsWith(`.${domain}`)) continue
      const configuredPath = fields.get('path')
      const path = configuredPath?.startsWith('/') ? configuredPath : pathname.slice(0, pathname.lastIndexOf('/')) || '/'
      const maxAge = fields.get('max-age')
      const expires = maxAge && /^-?\d+$/.test(maxAge) ? now() + Number(maxAge) * 1000 : Date.parse(fields.get('expires') ?? '')
      const expiresAt = Number.isNaN(expires) ? Infinity : expires
      const key = `${path}\x00${name}`
      if (!value || expiresAt <= now()) cookies.delete(key)
      else cookies.set(key, { name, value, path, secure: fields.has('secure'), expiresAt })
    }
    if (login || sentCsrf === csrf) {
      csrf = header(headers, 'x-updated-csrf-token') ?? (login || !csrf ? header(headers, 'x-csrf-token') : csrf)
    }
  }

  function cookieHeader(pathname: string) {
    const matching: Cookie[] = []
    for (const [key, cookie] of cookies) {
      if (cookie.expiresAt <= now()) {
        cookies.delete(key)
        continue
      }
      if (cookie.secure && origin.protocol !== 'https:') continue
      const prefix = cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`
      if (pathname === cookie.path || pathname.startsWith(prefix)) matching.push(cookie)
    }
    return matching.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  async function send(method: Method, path: string, payload?: unknown, login = false) {
    const activeGeneration = generation
    try {
      const url = new URL(path, origin)
      if (url.origin !== origin.origin) throw new UnifiError('UNIFI_INVALID_URL')
      const cookie = cookieHeader(url.pathname)
      const sentCsrf = csrf
      // Include the session token on read-only POSTs as well.
      const response = await request(url, {
        dispatcher, method, signal: AbortSignal.timeout(15_000),
        headersTimeout: 15_000, bodyTimeout: 15_000,
        headers: {
          accept: 'application/json',
          ...(cookie && { cookie }),
          ...(method !== 'GET' && sentCsrf && { 'x-csrf-token': sentCsrf }),
          ...(payload !== undefined && { 'content-type': 'application/json' }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      })
      const status = response.statusCode
      const raw = await response.body.text()
      if (status === 401) throw new UnifiError(loginRequiredCode, status)
      if (status === 403) throw new UnifiError('UNIFI_FORBIDDEN', status)
      if (status === 429) throw new UnifiError('UNIFI_RATE_LIMITED', status)
      if (header(response.headers, 'content-type')?.includes('text/html') || /^\s*</.test(raw)) {
        throw new UnifiError('UNIFI_HTML', status)
      }
      if (status < 200 || status >= 300) {
        throw new UnifiError(status === 404 ? 'UNIFI_NOT_FOUND' : 'UNIFI_HTTP', status)
      }
      let data: unknown = null
      if (raw.trim()) {
        try { data = JSON.parse(raw) as unknown } catch { throw new UnifiError('UNIFI_INVALID_RESPONSE') }
      }
      const parsed = envelope.safeParse(data)
      if (loginRequired.safeParse(data).success || parsed.data?.meta.msg === 'api.err.LoginRequired') {
        throw new UnifiError(loginRequiredCode, 401)
      }
      if (parsed.success && parsed.data.meta.rc !== 'ok') throw new UnifiError('UNIFI_API_ERROR')
      if (!parsed.success && hasMeta.safeParse(data).success) throw new UnifiError('UNIFI_INVALID_RESPONSE')
      if (login || activeGeneration === generation && session) acceptHeaders(response.headers, url.pathname, login, sentCsrf)
      return parsed.success ? parsed.data.data : data
    } catch (error) {
      throw transportError(error)
    }
  }

  function registerFailure(error: unknown) {
    failures++
    if (error instanceof UnifiError && (authStatuses.has(error.status ?? 0) || error.code === 'UNIFI_LOGIN_RESPONSE')) authFailures++
    else authFailures = 0
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6))
    retryAt = now() + Math.round(delay * (0.75 + random() * 0.5))
    statusError(authFailures >= 3 ? 'UNIFI_AUTH_LOCKED' : unifiErrorCode(error))
  }

  function authenticate(): Promise<void> {
    if (closed || options.canLogin?.() === false) return Promise.reject(new UnifiError('UNIFI_INACTIVE'))
    if (session) return Promise.resolve()
    if (loginInFlight) return loginInFlight
    if (authFailures >= 3) return Promise.reject(new UnifiError('UNIFI_AUTH_LOCKED'))
    if (now() < retryAt) return Promise.reject(new UnifiError('UNIFI_LOGIN_BACKOFF'))

    loginInFlight = (async () => {
      cookies.clear()
      csrf = undefined
      try {
        await send('POST', paths.login, { username: config.username, password: config.password, rememberMe: true }, true)
        if (!cookieHeader(paths.classic('stat/sysinfo')) || !csrf) throw new UnifiError('UNIFI_LOGIN_RESPONSE')
        generation++
        session = true
      } catch (error) {
        registerFailure(error)
        throw error
      } finally {
        loginInFlight = undefined
      }
    })()
    return loginInFlight
  }

  function invalidate(current: number, failed = false) {
    if (!session || current !== generation) return
    session = false
    if (failed) registerFailure(new UnifiError(loginRequiredCode, 401))
  }

  function confirm(current: number) {
    if (!session || generation !== current) return
    failures = 0
    authFailures = 0
    retryAt = 0
    statusError(null)
  }

  async function sendAuthenticated(method: Method, path: string, payload?: unknown) {
    for (let attempt = 0; ; attempt++) {
      await authenticate()
      const activeGeneration = generation
      try {
        const result = await send(method, path, payload)
        confirm(activeGeneration)
        return result
      } catch (error) {
        if (!(error instanceof UnifiError) || error.code !== loginRequiredCode) throw error
        invalidate(activeGeneration, attempt > 0)
        if (attempt > 0) throw error
      }
    }
  }

  function sendPost(method: Exclude<Method, 'GET'>, path: string, payload?: unknown) {
    // Read-only POSTs share the CSRF token used by writes.
    const result = postQueue.then(() => sendAuthenticated(method, path, payload))
    postQueue = result.then(() => {}, () => {})
    return result
  }

  return {
    origin, paths, connect,
    localIp: () => localIp,
    lastError: () => lastError,
    async wsSession() {
      await authenticate()
      return { cookie: cookieHeader(paths.events), generation }
    },
    invalidate,
    confirm,
    async reconnect() {
      await loginInFlight?.catch(() => {})
      failures = 0
      authFailures = 0
      retryAt = 0
      statusError(null)
      session = false
    },
    async close() {
      closed = true
      await dispatcher.destroy()
    },
    read: (path: string) => sendAuthenticated('GET', path),
    postRead: (path: string, payload: unknown) => sendPost('POST', path, payload),
    write: sendPost,
  }
}

export type UnifiTransport = ReturnType<typeof createUnifiTransport>
