const windowMs = 15 * 60 * 1000
const ipLimit = 10
const usernameLimit = 5

export function createLoginLimiter(now = Date.now) {
  const byIp = new Map<string, number[]>()
  const byUsername = new Map<string, number[]>()
  let lastSweep = now()

  function take(ip: string, username?: string) {
    const ts = now()
    const cutoff = ts - windowMs
    if (ts - lastSweep >= windowMs) {
      for (const attempts of [byIp, byUsername]) {
        for (const [key, history] of attempts) {
          if ((history.at(-1) ?? 0) <= cutoff) attempts.delete(key)
        }
      }
      lastSweep = ts
    }

    const checks = [{ store: byIp, key: ip, limit: ipLimit }]
    if (username !== undefined) checks.push({ store: byUsername, key: username.toLowerCase(), limit: usernameLimit })
    const attempts = checks.map(check => ({
      ...check,
      history: (check.store.get(check.key) ?? []).filter(at => at > cutoff),
    }))
    const retryAfterMs = Math.max(0, ...attempts.map(
      ({ history, limit }) => history.length >= limit ? (history[0] ?? ts) - cutoff : 0,
    ))
    if (retryAfterMs > 0) return retryAfterMs

    for (const { store, key, history } of attempts) {
      store.set(key, [...history, ts])
    }
    return 0
  }

  return { take }
}
