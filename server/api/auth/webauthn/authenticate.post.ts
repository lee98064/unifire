import { defineEventHandler } from 'nuxt/server'
import { createLoginLimiter } from '../../../services/login-limit'
import { createChallengeStore, createPasskeysService } from '../../../services/passkeys'
import { createUsersService } from '../../../services/users'
import { apiError } from '../../../utils/api-error'
import { checkLoginLimit, completeLogin, recordLoginFailure } from '../../../utils/auth'
import { authenticationBody, webAuthnChallengeCodes, readWebAuthnBody, hasWebAuthnErrorCode } from '../../../utils/webauthn'

const challenges = createChallengeStore()
const limiter = createLoginLimiter()
const invalidCredentials = () => apiError(401, 'INVALID_CREDENTIALS', 'errors.invalidCredentials')

export default defineEventHandler(async event => {
  event.res.headers.set('Cache-Control', 'no-store')
  const input = await readWebAuthnBody(event, authenticationBody)
  const username = input.userName?.toLowerCase()
  if (!input.verify) checkLoginLimit(event, limiter, username)
  const scope = username ?? ''
  const service = createPasskeysService()
  const users = createUsersService()

  return defineWebAuthnAuthenticateEventHandler({
    getOptions: () => ({ userVerification: 'required', timeout: 5 * 60_000 }),
    storeChallenge: (_, challenge, attemptId) => challenges.store(attemptId, challenge, scope),
    getChallenge: (_, attemptId) => challenges.consume(attemptId, scope),
    getCredential: (_, credentialId) => {
      const credential = service.find(credentialId)
      if (!credential) throw invalidCredentials()
      return credential
    },
    onSuccess: async (_, { credential, authenticationInfo }) => {
      if (!input.verify || !authenticationInfo.userVerified) throw invalidCredentials()
      const user = users.find(credential.userId)
      if (!user || (username !== undefined && user.username.toLowerCase() !== username)) throw invalidCredentials()
      const userHandle = input.response.response.userHandle
      if (userHandle !== undefined && userHandle !== Buffer.from(user.id).toString('base64url')) throw invalidCredentials()
      if (!service.markUsed(credential, authenticationInfo.newCounter, authenticationInfo.credentialBackedUp)) {
        throw invalidCredentials()
      }
      const updated = users.markLogin(user.id, user.authVersion)
      if (!updated) throw invalidCredentials()
      await completeLogin(event, updated, 'passkey')
    },
    onError: (_, error) => {
      if (hasWebAuthnErrorCode(error.data, webAuthnChallengeCodes)) throw error
      if (input.verify) recordLoginFailure('passkey')
      throw invalidCredentials()
    },
  })(event)
})
