import { randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_DATA_DIR = './.data'

function hasCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function readPrivateKey(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('Unifire key paths must be regular files')
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function loadOrCreateKey(dataDir: string, name: string, generate: () => Buffer) {
  const path = join(dataDir, name)
  try {
    return readPrivateKey(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const temporaryPath = join(dataDir, `.${name}.${randomBytes(12).toString('hex')}`)
  const fd = openSync(temporaryPath, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, generate())
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    // A fully written file wins atomically even if two processes start together.
    try {
      linkSync(temporaryPath, path)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
  } finally {
    unlinkSync(temporaryPath)
  }
  return readPrivateKey(path)
}

export function loadEncryptionKey(dataDir: string, secret = process.env.NUXT_UNIFIRE_SECRET): Buffer {
  if (!secret) {
    const key = loadOrCreateKey(dataDir, 'secret.key', () => randomBytes(32))
    if (key.length === 32) return key
    throw new Error('The Unifire secret.key file must contain 32 bytes')
  }

  const value = secret.trim()
  if (/^[\da-f]{64}$/i.test(value)) return Buffer.from(value, 'hex')
  if (/^[\da-z+/_-]{43}=?$/i.test(value)) {
    const key = Buffer.from(value, 'base64url')
    if (key.length === 32 && key.toString('base64url') === value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')) {
      return key
    }
  }
  if (Buffer.byteLength(secret) === 32) return Buffer.from(secret)
  throw new Error('NUXT_UNIFIRE_SECRET must encode exactly 32 bytes as Base64, hex, or raw text')
}

export function loadSessionPassword(dataDir: string, password = process.env.NUXT_SESSION_PASSWORD) {
  const value = password || loadOrCreateKey(
    dataDir, 'session.key', () => Buffer.from(randomBytes(32).toString('base64url')),
  ).toString('utf8').trim()
  if (value.length < 32) throw new Error('The Unifire session password must have at least 32 characters')
  return value
}
