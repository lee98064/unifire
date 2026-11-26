import { defineEventHandler } from 'nuxt/server'
import { createAuditService, userActor } from '../../../services/audit'
import { createChallengeStore, createPasskeysService } from '../../../services/passkeys'
import { apiError } from '../../../utils/api-error'
import { activeSessionUser, requireAccount } from '../../../utils/auth'
import { defineWebAuthnRegisterEventHandler, registrationBody, webAuthnChallengeCodes, readWebAuthnBody, hasWebAuthnErrorCode } from '../../../utils/webauthn'

const challenges = createChallengeStore()

export default defineEventHandler(async event => {
  const { row, session } = await requireAccount(event)
  await readWebAuthnBody(event, registrationBody)
  const scope = `${row.id}:${session.id}:${row.authVersion}`
  const service = createPasskeysService()

  return defineWebAuthnRegisterEventHandler({
    validateUser: () => ({ userName: row.username, displayName: row.displayName }),
    getOptions: () => ({
      rpName: 'Unifire',
      userID: new TextEncoder().encode(row.id),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 5 * 60_000,
    }),
    excludeCredentials: () => service.descriptors(row.id),
    storeChallenge: (_, challenge, attemptId) => challenges.store(attemptId, challenge, scope),
    getChallenge: (_, attemptId) => challenges.consume(attemptId, scope),
    onSuccess: (_, { credential, registrationInfo }) => {
      if (!registrationInfo.userVerified) throw apiError(400, 'WEBAUTHN_REGISTRATION_FAILED', 'errors.webAuthnRegistrationFailed')
      const current = activeSessionUser(session)
      if (!current) throw apiError(401, 'AUTH_REQUIRED', 'errors.authRequired')
      if (!service.register(current.id, credential)) {
        throw apiError(409, 'WEBAUTHN_ALREADY_REGISTERED', 'errors.webAuthnAlreadyRegistered')
      }
      createAuditService().record({
        actor: userActor(current), category: 'auth', action: 'auth.passkeyRegistered', severity: 'success',
        messageKey: 'audit.auth.passkeyRegistered', messageParams: { username: current.username },
      })
    },
    onError: (_, error) => {
      const codes = [...webAuthnChallengeCodes, 'AUTH_REQUIRED', 'WEBAUTHN_ALREADY_REGISTERED']
      if (hasWebAuthnErrorCode(error.data, codes)) throw error
      throw apiError(400, 'WEBAUTHN_REGISTRATION_FAILED', 'errors.webAuthnRegistrationFailed')
    },
  })(event)
})
