/** SCREAMING_CASE error code → i18n key under `errors.` (UNIFI_ROUTE_DRIFT → errors.unifiRouteDrift). */
export function errorCodeKey(code: string) {
  return `errors.${code.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`
}

/**
 * Translate text the server sends as an i18n key or error code (status details, error keys, state details).
 * Unknown values fall back to the raw string so nothing renders empty.
 */
export function useMsg() {
  const { t, te } = useI18n()
  return (key?: string | null, params?: Record<string, unknown>) => {
    if (!key) return ''
    const k = /^[A-Z0-9_]+$/.test(key) ? errorCodeKey(key) : key
    return te(k) ? t(k, params ?? {}) : key
  }
}
