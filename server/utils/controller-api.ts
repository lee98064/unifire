import { defineEventHandler, type H3Event } from 'h3'
import type { SessionUserT } from '#shared/schemas/auth'
import { UnifiError } from '../unifi/errors'
import { apiError } from './api-error'
import { requireAdmin } from './auth'

const errorKeys: Record<string, [number, string]> = {
  UNIFI_INVALID_URL: [400, 'errors.unifiInvalidUrl'],
  UNIFI_INVALID_SITE: [400, 'errors.unifiInvalidSite'],
  UNIFI_INVALID_FINGERPRINT: [400, 'errors.unifiInvalidFingerprint'],
  UNIFI_CA_REQUIRED: [400, 'errors.unifiCaRequired'],
  UNIFI_PASSWORD_REQUIRED: [400, 'errors.unifiPasswordRequired'],
  UNIFI_INACTIVE: [503, 'errors.unifiInactive'],
  UNIFI_NOT_CONFIGURED: [409, 'errors.unifiNotConfigured'],
  UNIFI_SNAPSHOT_INCOMPLETE: [409, 'errors.unifiSnapshotIncomplete'],
  UNIFI_TIMEOUT: [504, 'errors.unifiTimeout'],
  UNIFI_ROUTE_NOT_FOUND: [404, 'errors.unifiNotFound'],
  ROUTE_NOT_OWNED: [409, 'errors.routeNotOwned'],
  UNIFI_ROUTE_DRIFT: [409, 'errors.unifiRouteDrift'],
  UNIFI_BLOCK_NOT_OWNED: [409, 'errors.unifiBlockNotOwned'],
  UNIFI_QUALIFICATION_REQUIRED: [409, 'errors.unifiQualificationRequired'],
  UNIFI_CLIENT_STATE_UNKNOWN: [409, 'errors.unifiClientStateUnknown'],
  CLIENT_NOT_FOUND: [404, 'errors.clientNotFound'],
  EGRESS_NOT_FOUND: [404, 'errors.egressNotFound'],
  PERSON_NOT_FOUND: [404, 'errors.personNotFound'],
}

export function adminControllerHandler<T>(handler: (event: H3Event, admin: SessionUserT) => T | Promise<T>) {
  return defineEventHandler(async (event): Promise<Awaited<T>> => {
    const admin = await requireAdmin(event)
    try {
      return await handler(event, admin)
    } catch (error) {
      if (!(error instanceof UnifiError)) throw error
      const [status, key] = errorKeys[error.code] ?? [502, 'errors.unifiRequestFailed']
      throw apiError(status, error.code, key)
    }
  })
}
