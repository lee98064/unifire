import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { GuestWifi, KioskPayload, type GuestWifiInput, type GuestWifiT } from '#shared/schemas/automation'
import type { Db } from '../db'
import { guestWifi } from '../db/schema'
import { createAuditService } from '../services/audit'
import { systemContext, type ControllerService } from '../services/controller'
import { createSettingsService } from '../services/settings'
import { UnifiError } from '../unifi/errors'
import { serializeSite, type WriteContext } from '../unifi/writes'
import { apiError } from '../utils/api-error'
import { decrypt, encrypt } from '../utils/crypto'
import { createCronJobs, nextCron, validateCron } from './automation-cron'
import { guestWords } from './guest-words'
import type { Notification } from './notifiers'

const digits = '0123456789'
const easy = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
const wordsByLength = new Map([3, 4, 5, 6].map(length => [length, guestWords.filter(word => word.length === length)]))
type Input = z.output<typeof GuestWifiInput>
const randomText = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]!).join('')

export function generateGuestPassphrase(style: GuestWifiT['rotation']['style'], length: number): string {
  if (!Number.isInteger(length) || length < 8 || length > 63) throw new RangeError('Invalid Wi-Fi passphrase length')
  if (style === 'digits') return randomText(digits, length)
  if (style === 'random') return randomText(easy, length)
  const words: string[] = []
  let remaining = length - 2
  while (remaining > 0) {
    // Every remaining length >= 3 is expressible with 3–6 letter words and separators.
    const candidates = [...wordsByLength].filter(([size]) => size === remaining || remaining - size - 1 >= 3)
    const [size, dictionary] = candidates[randomInt(candidates.length)]!
    words.push(dictionary[randomInt(dictionary.length)]!)
    remaining -= size === remaining ? size : size + 1
  }
  return words.join('-') + randomText(digits, 2)
}

const hash = (value: string) => createHash('sha256').update(value).digest()
const reveal = (value: string | null | undefined) => value ? z.string().parse(decrypt(value)) : null
const qrEscape = (value: string) => value.replace(/([\\;,:"])/g, '\\$1')
const kioskMissing = () => apiError(404, 'KIOSK_NOT_FOUND', 'errors.kioskNotFound')
const rotationDefault: Input['rotation'] = { cron: '0 4 * * 1', timezone: 'Asia/Taipei', style: 'words', length: 12 }

export function createGuestWifi(db: Db, service: ControllerService, notify: (event: Notification) => Promise<void>, now = Date.now) {
  const readSettings = createSettingsService(db)
  const audit = createAuditService(db)
  const jobs = createCronJobs()
  let leased: (() => boolean) | undefined
  const queue = <T>(work: () => T | Promise<T>) => serializeSite('unifire-guest-wifi', work)
  const row = () => db.select().from(guestWifi).where(eq(guestWifi.id, 1)).get()
  const blank = () => ({ wlanId: null, ssid: null, enabled: false,
    rotation: { ...rotationDefault, timezone: readSettings.get().timezone }, lastRotatedAt: null })

  function get() {
    const saved = row()
    const view = saved ?? blank()
    const kioskToken = reveal(saved?.encryptedKioskToken)
    const site = readSettings.get().siteUrl
    const kiosk = kioskToken ? `/kiosk/${kioskToken}` : null
    return GuestWifi.parse({ ...view, kioskToken, kioskUrl: kiosk && site ? `${site.replace(/\/+$/, '')}${kiosk}` : kiosk,
      passphrase: reveal(saved?.encryptedPassphrase), nextRotationAt: view.enabled && view.wlanId ? nextCron(view.rotation, now()) : null })
  }

  function runtime() {
    const run = service.runtime
    if (!run?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    return run
  }

  function sync() {
    if (!leased) return
    const value = row()
    jobs.set('guest-wifi', value?.enabled && value.wlanId ? value.rotation : null,
      () => leased?.() ? rotate(systemContext) : Promise.resolve())
  }

  const save = (input: Input) => queue(async () => {
    validateCron(input.rotation)
    if (input.enabled && !input.wlanId) throw apiError(400, 'GUEST_WLAN_REQUIRED', 'errors.guestWlanRequired')
    const previous = row()
    const wlan = input.wlanId ? (await runtime().api.wlan(input.wlanId)).find(doc => doc._id === input.wlanId) : null
    if (input.wlanId && !wlan) throw apiError(404, 'WLAN_NOT_FOUND', 'errors.wlanNotFound')
    if (wlan && input.enabled && wlan.security !== 'wpapsk') throw new UnifiError('WLAN_PSK_REQUIRED', 409)
    const passphrase = wlan?.security === 'wpapsk' && typeof wlan.x_passphrase === 'string' && wlan.x_passphrase.length >= 8
      ? encrypt(wlan.x_passphrase) : null
    const changed = input.wlanId !== previous?.wlanId
    const fields = { ...input, ssid: wlan?.name ?? null,
      encryptedPassphrase: passphrase ?? (!changed && wlan?.security === 'wpapsk' ? previous?.encryptedPassphrase ?? null : null),
      lastRotatedAt: changed ? null : previous?.lastRotatedAt ?? null,
      nextRotationAt: input.enabled ? nextCron(input.rotation, now()) : null }
    db.insert(guestWifi).values({ id: 1, ...fields }).onConflictDoUpdate({ target: guestWifi.id, set: fields }).run()
    sync()
    return get()
  })

  const rotate = (ctx: WriteContext) => queue(async () => {
    const saved = row()
    if (!saved?.wlanId) throw apiError(409, 'GUEST_WLAN_REQUIRED', 'errors.guestWlanRequired')
    const run = runtime()
    const passphrase = generateGuestPassphrase(saved.rotation.style, saved.rotation.length)
    const result = await run.writes.updateWlan(saved.wlanId, { x_passphrase: passphrase }, ctx)
    if (!result.dryRun) {
      const at = now()
      db.update(guestWifi).set({ encryptedPassphrase: encrypt(passphrase), lastRotatedAt: at,
        nextRotationAt: saved.enabled ? nextCron(saved.rotation, at) : null }).where(eq(guestWifi.id, 1)).run()
      audit.record({ actor: ctx.actor, category: 'wifi', action: 'guestWifi.rotated', severity: 'success',
        target: { type: 'wlan', id: saved.wlanId, label: saved.ssid ?? saved.wlanId },
        messageKey: 'audit.guestWifi.rotated', messageParams: { ssid: saved.ssid ?? saved.wlanId } }, at)
      await notify({ event: 'guest_wifi_rotated', data: { wlanId: saved.wlanId, ssid: saved.ssid } }).catch(() => {})
    }
    return get()
  })

  return {
    get, save, rotate,
    resetToken: () => queue(() => {
      const token = randomBytes(32).toString('base64url')
      const fields = { encryptedKioskToken: encrypt(token), kioskTokenHash: hash(token).toString('hex') }
      db.insert(guestWifi).values({ id: 1, ...blank(), ...fields }).onConflictDoUpdate({ target: guestWifi.id, set: fields }).run()
      return get()
    }),
    kiosk(token: string) {
      const saved = row()
      const expected = Buffer.from(saved?.kioskTokenHash ?? '0'.repeat(64), 'hex')
      const matches = expected.length === 32 && timingSafeEqual(hash(token), expected)
      if (!matches || !saved?.ssid || !saved.encryptedPassphrase) throw kioskMissing()
      const passphrase = reveal(saved.encryptedPassphrase)!
      return KioskPayload.parse({ ssid: saved.ssid, passphrase, title: saved.ssid,
        validUntil: saved.enabled ? nextCron(saved.rotation, now()) : null,
        wifiUri: `WIFI:T:WPA;S:${qrEscape(saved.ssid)};P:${qrEscape(passphrase)};;` })
    },
    start(hasLease: () => boolean) {
      leased = hasLease
      sync()
      return async () => {
        leased = undefined
        jobs.stop()
        await queue(() => {})
      }
    },
  }
}
