import { readValidatedBody, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { apiError } from './api-error'

// The package gates these imports behind a Nuxt module option.
export { defineWebAuthnRegisterEventHandler } from '../../node_modules/nuxt-auth-utils/dist/runtime/server/lib/webauthn/register.js'
export { defineWebAuthnAuthenticateEventHandler } from '../../node_modules/nuxt-auth-utils/dist/runtime/server/lib/webauthn/authenticate.js'

const encoded = z.string().min(1).max(64 * 1024).regex(/^[A-Za-z0-9_-]+$/)
const userName = z.string().min(1).max(64)
const publicKey = {
  id: encoded,
  rawId: encoded,
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
}
const response = { clientDataJSON: encoded }
const attemptId = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const user = z.looseObject({ userName, displayName: z.string().max(64).optional() })

// These two exchanges are described by nuxt-auth-utils; shared/api.ts lists only their paths.
export const registrationBody = z.discriminatedUnion('verify', [
  z.object({ verify: z.literal(false), user }),
  z.object({
    verify: z.literal(true), attemptId, user,
    response: z.looseObject({
      ...publicKey,
      response: z.looseObject({ ...response, attestationObject: encoded }),
    }),
  }),
])

export const authenticationBody = z.discriminatedUnion('verify', [
  z.object({ verify: z.literal(false), userName: userName.optional() }),
  z.object({
    verify: z.literal(true), attemptId, userName: userName.optional(),
    response: z.looseObject({
      ...publicKey,
      response: z.looseObject({
        ...response, authenticatorData: encoded, signature: encoded, userHandle: encoded.optional(),
      }),
    }),
  }),
])

export const webAuthnChallengeCodes = ['WEBAUTHN_BUSY', 'WEBAUTHN_CHALLENGE_INVALID']

export async function readWebAuthnBody<T>(event: RequestEvent, schema: z.ZodType<T>): Promise<T> {
  if (event.req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  }
  try {
    return await readValidatedBody(event, value => schema.parse(value))
  } catch {
    throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  }
}

export function hasWebAuthnErrorCode(data: unknown, codes: string[]) {
  return typeof data === 'object' && data !== null && 'code' in data
    && typeof data.code === 'string' && codes.includes(data.code)
}
