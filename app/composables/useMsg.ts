/**
 * Translate text the server sends as an i18n key (status details, error keys, state details).
 * Unknown keys fall back to the raw string so nothing renders empty.
 */
export function useMsg() {
  const { t, te } = useI18n()
  return (key?: string | null, params?: Record<string, unknown>) => (!key ? '' : te(key) ? t(key, params ?? {}) : key)
}
