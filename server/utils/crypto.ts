import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

const version = 'v1'
const algorithm = 'aes-256-gcm'
const nonceSize = 12
const tagSize = 16

export function createCrypto(key: Buffer) {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key')
  const secret = Buffer.from(key)

  function encrypt(value: z.input<typeof jsonValue>): string {
    const serialized = JSON.stringify(value)
    const nonce = randomBytes(nonceSize)
    const cipher = createCipheriv(algorithm, secret, nonce, { authTagLength: tagSize })
    const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()])
    return `${version}.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
  }

  function decrypt(encoded: string): z.output<typeof jsonValue> {
    const [format, body, extra] = encoded.split('.')
    if (format !== version || !body || extra !== undefined) throw new Error('Invalid encrypted value')
    const bytes = Buffer.from(body, 'base64url')
    if (bytes.length <= nonceSize + tagSize || bytes.toString('base64url') !== body) {
      throw new Error('Invalid encrypted value')
    }
    try {
      const nonce = bytes.subarray(0, nonceSize)
      const tag = bytes.subarray(nonceSize, nonceSize + tagSize)
      const ciphertext = bytes.subarray(nonceSize + tagSize)
      const decipher = createDecipheriv(algorithm, secret, nonce, { authTagLength: tagSize })
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      return jsonValue.parse(JSON.parse(plaintext))
    } catch {
      throw new Error('Invalid encrypted value')
    }
  }

  return { encrypt, decrypt }
}

const jsonValue = z.json()
let configuredCrypto: ReturnType<typeof createCrypto> | undefined

export function initializeCrypto(key: Buffer) {
  configuredCrypto = createCrypto(key)
}

function getCrypto() {
  if (!configuredCrypto) throw new Error('Unifire encryption has not been initialized')
  return configuredCrypto
}

export function encrypt(value: Parameters<ReturnType<typeof createCrypto>['encrypt']>[0]) {
  return getCrypto().encrypt(value)
}

export function decrypt(value: string) {
  return getCrypto().decrypt(value)
}
