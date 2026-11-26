import type { SessionUserT } from '#shared/schemas/auth'

declare module '#auth-utils' {
  interface User extends SessionUserT {}

  interface SecureSessionData {
    authVersion?: number
    expiresAt?: number
  }
}
