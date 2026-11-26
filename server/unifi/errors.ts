export class UnifiError extends Error {
  constructor(readonly code: string, readonly status?: number, options?: ErrorOptions) {
    super(code, options)
    this.name = 'UnifiError'
  }
}

export function unifiErrorCode(error: unknown): string {
  return error instanceof UnifiError ? error.code : 'UNIFI_UNREACHABLE'
}

export function unifiStatusKey(code: string | null) {
  if (code === null) return null
  const keys: Record<string, string> = {
    UNIFI_AUTH_REQUIRED: 'controllerError.authRequired',
    UNIFI_AUTH_LOCKED: 'controllerError.authLocked',
    UNIFI_LOGIN_BACKOFF: 'controllerError.loginBackoff',
    UNIFI_LOGIN_RESPONSE: 'controllerError.loginResponse',
    UNIFI_FORBIDDEN: 'controllerError.forbidden',
    UNIFI_RATE_LIMITED: 'controllerError.rateLimited',
    UNIFI_FINGERPRINT_MISMATCH: 'controllerError.fingerprintMismatch',
    UNIFI_TLS: 'controllerError.tls',
    UNIFI_HTML: 'controllerError.html',
    UNIFI_HTTP: 'controllerError.http',
    UNIFI_TIMEOUT: 'controllerError.timeout',
    UNIFI_NOT_FOUND: 'controllerError.notFound',
    UNIFI_ROUTE_NOT_FOUND: 'controllerError.notFound',
    UNIFI_EMPTY: 'capability.empty',
    UNIFI_INVALID_RESPONSE: 'controllerError.invalidResponse',
    UNIFI_API_ERROR: 'controllerError.api',
    UNIFI_WEBSOCKET: 'controllerError.websocket',
    UNIFI_VERIFY_FAILED: 'controllerError.verifyFailed',
    UNIFI_ROUTE_DRIFT: 'errors.unifiRouteDrift',
    ROUTE_NOT_OWNED: 'errors.routeNotOwned',
    UNIFI_QUALIFICATION_REQUIRED: 'errors.unifiQualificationRequired',
  }
  return keys[code] ?? 'errors.unifiRequestFailed'
}

export function isUnsupported(error: unknown) {
  return error instanceof UnifiError && (error.status === 404 || error.status === 405 || error.status === 501)
}
