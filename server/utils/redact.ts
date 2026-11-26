const secretKeys = new Set([
  'password', 'passwordhash', 'encryptedpassword', 'currentpassword', 'newpassword',
  'passphrase', 'psk', 'presharedkey', 'privatekey', 'secret', 'secretkey', 'sharedsecret',
  'token', 'bottoken', 'apikey', 'accesstoken', 'refreshtoken', 'kiosktoken', 'webhookurl',
  'sessionpassword', 'appsecret', 'authorization', 'cookie', 'setcookie', 'authtoken',
  'credentials', 'clientsecret', 'encryptedconfig', 'encrypteddoc', 'encryptedkeys',
])

export const REDACTED = '[redacted]'

export function isSecretKey(key: string) {
  const lower = key.toLowerCase()
  const normalized = lower.replace(/[_-]/g, '')
  return lower.startsWith('x_')
    || secretKeys.has(normalized)
    || /(?:password|passphrase|privatekey|presharedkey|token)$/.test(normalized)
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, isSecretKey(key) ? REDACTED : redactSecrets(entry),
    ]))
  }
  return value
}
