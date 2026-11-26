import { and, eq } from 'drizzle-orm'
import type { WebAuthnCredential } from '#auth-utils'
import { useDb } from '../db'
import { passkeys } from '../db/schema'
import { apiError } from '../utils/api-error'

const challengeTtlMs = 5 * 60_000
const maxPending = 1024

export function createChallengeStore(now = Date.now) {
  const pending = new Map<string, { challenge: string, scope: string, expiresAt: number }>()

  function store(attemptId: string, challenge: string, scope: string) {
    const ts = now()
    if (pending.size >= maxPending) {
      for (const [id, attempt] of pending) {
        if (attempt.expiresAt <= ts) pending.delete(id)
      }
      if (pending.size >= maxPending) {
        throw apiError(429, 'WEBAUTHN_BUSY', 'errors.webAuthnBusy')
      }
    }
    pending.set(attemptId, { challenge, scope, expiresAt: ts + challengeTtlMs })
  }

  function consume(attemptId: string, scope: string) {
    const attempt = pending.get(attemptId)
    if (!attempt || attempt.expiresAt <= now() || attempt.scope !== scope) {
      throw apiError(400, 'WEBAUTHN_CHALLENGE_INVALID', 'errors.webAuthnChallengeInvalid')
    }
    pending.delete(attemptId)
    return attempt.challenge
  }

  return { store, consume }
}

export function createPasskeysService(db = useDb()) {
  function descriptors(userId: string) {
    return db.select({ id: passkeys.id, transports: passkeys.transports }).from(passkeys)
      .where(eq(passkeys.userId, userId)).all()
      .map(({ id, transports }) => ({ id, transports: transports ?? undefined }))
  }

  function find(id: string) {
    const credential = db.select().from(passkeys).where(eq(passkeys.id, id)).get()
    if (credential) return { ...credential, transports: credential.transports ?? undefined, aaguid: credential.aaguid ?? undefined }
  }

  function register(userId: string, credential: WebAuthnCredential) {
    return db.insert(passkeys).values({
      userId,
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      backedUp: credential.backedUp,
      transports: credential.transports,
      aaguid: credential.aaguid,
      createdAt: Date.now(),
    }).onConflictDoNothing({ target: passkeys.id }).run().changes === 1
  }

  function markUsed(credential: NonNullable<ReturnType<typeof find>>, counter: number, backedUp: boolean) {
    return db.update(passkeys).set({ counter, backedUp, lastUsedAt: Date.now() })
      .where(and(eq(passkeys.id, credential.id), eq(passkeys.counter, credential.counter))).run().changes === 1
  }

  return { descriptors, find, register, markUsed }
}
