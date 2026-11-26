import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getTableName, is, Table } from 'drizzle-orm'
import { createDatabase } from '~~/server/db'
import * as schema from '~~/server/db/schema'
import { acquireLease, releaseLease, renewLease } from '~~/server/services/lease'
import { createCrypto } from '~~/server/utils/crypto'
import { loadEncryptionKey, loadSessionPassword } from '~~/server/utils/keys'
import { createSettingsService } from '~~/server/services/settings'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
  cleanups.length = 0
})

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'unifire-wp1-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function openDb(filename?: string) {
  const connection = createDatabase(filename)
  cleanups.push(() => connection.sqlite.close())
  return connection
}

describe('database and lease', () => {
  it('migrates all Drizzle tables and enables foreign keys and WAL on a file database', () => {
    const filename = join(tempDir(), 'unifire.db')
    const first = openDb(filename)
    const second = openDb(filename)
    const names = first.sqlite.prepare<[], string>("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all()
    expect(names.sort()).toEqual([
      '_migrations', ...Object.values(schema).filter(value => is(value, Table)).map(getTableName),
    ].sort())
    expect(second.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(second.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(second.sqlite.prepare('SELECT version FROM _migrations').pluck().all()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(() => second.db.insert(schema.personGroups).values({ personId: 'p', groupId: 'g' }).run())
      .toThrow(/FOREIGN KEY/)
  })

  it('allows only the owner to extend or release a current lease', () => {
    const filename = join(tempDir(), 'unifire.db')
    const { db: first } = openDb(filename)
    const { db: second } = openDb(filename)
    expect(acquireLease('engine', 'one', 100, first, 0)).toBe(true)
    expect(acquireLease('engine', 'two', 100, second, 25)).toBe(false)
    expect(renewLease('engine', 'two', 100, second, 50)).toBe(false)
    expect(renewLease('engine', 'one', 100, first, 50)).toBe(true)
    expect(acquireLease('engine', 'two', 100, second, 100)).toBe(false)
    expect(renewLease('engine', 'one', 100, first, 150)).toBe(false)
    expect(acquireLease('engine', 'two', 100, second, 150)).toBe(true)
    expect(releaseLease('engine', 'one', first)).toBe(false)
    expect(releaseLease('engine', 'two', second)).toBe(true)
  })
})

describe('keys and encryption', () => {
  it('persists independent owner-only keys and honors supplied keys', () => {
    const dataDir = tempDir()
    const encryptionKey = loadEncryptionKey(dataDir, '')
    const sessionPassword = loadSessionPassword(dataDir, '')
    expect(encryptionKey).toHaveLength(32)
    expect(sessionPassword.length).toBeGreaterThanOrEqual(32)
    for (const file of ['secret.key', 'session.key']) {
      expect(statSync(join(dataDir, file)).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(join(dataDir, 'secret.key'))).toEqual(encryptionKey)
    expect(loadEncryptionKey(dataDir, '')).toEqual(encryptionKey)
    expect(loadSessionPassword(dataDir, '')).toBe(sessionPassword)
    const explicit = randomBytes(32)
    expect(loadEncryptionKey(dataDir, explicit.toString('hex'))).toEqual(explicit)
    expect(loadEncryptionKey(dataDir, explicit.toString('base64'))).toEqual(explicit)
    expect(loadSessionPassword(dataDir, explicit.toString('base64url'))).toBe(explicit.toString('base64url'))
  })

  it('round-trips strings and JSON and detects tampering and a wrong key', () => {
    const cipher = createCrypto(randomBytes(32))
    const value = { nested: [null, { boolean: false }, 42], label: '測試' }
    const wrapped = cipher.encrypt(value)
    expect(cipher.decrypt(wrapped)).toEqual(value)
    expect(cipher.decrypt(cipher.encrypt('{"json-looking":"string"}'))).toBe('{"json-looking":"string"}')
    expect(cipher.encrypt(value)).not.toBe(wrapped)
    const bytes = Buffer.from(wrapped.split('.')[1]!, 'base64url')
    bytes.writeUInt8(bytes.readUInt8(12) ^ 1, 12)
    expect(() => cipher.decrypt(`v1.${bytes.toString('base64url')}`)).toThrow('Invalid encrypted value')
    expect(() => createCrypto(randomBytes(32)).decrypt(wrapped)).toThrow('Invalid encrypted value')
  })
})

describe('settings', () => {
  it('reads defaults and persists a top-level patch without disturbing other keys', () => {
    const { db } = openDb()
    const service = createSettingsService(db)
    const defaults = service.get()
    expect(defaults).toMatchObject({
      timezone: 'Asia/Taipei', siteUrl: null, probe: { intervalSec: 30, sweepIntervalMin: 60, method: 'tcp', failThreshold: 3 },
      approval: { mode: 'notify', matchRandomizedByHostname: true }, presence: { graceMinutes: 10 },
      usage: { activeThresholdBytes: 51200, retainRawDays: 14 }, excludedRouteIds: [],
      snapshots: { cron: '0 3 * * *', retainDays: 90, preWrite: true },
      broadcastOverrides: {}, selfMacOverride: null,
    })
    expect(defaults.probe.ipPool).toHaveLength(16)
    const saved = service.patch({ timezone: 'UTC', siteUrl: 'https://unifire.example.com', excludedRouteIds: ['route'] })
    expect(saved).toEqual({ ...defaults, timezone: 'UTC', siteUrl: 'https://unifire.example.com', excludedRouteIds: ['route'] })
    expect(createSettingsService(db).get()).toEqual(saved)
    expect(() => service.patch({ timezone: 'Invalid/Timezone', excludedRouteIds: [] }))
      .toThrow(expect.objectContaining({ data: { code: 'INVALID_TIMEZONE' } }))
    expect(service.get()).toEqual(saved)
    expect(service.patch({ siteUrl: null }).siteUrl).toBeNull()
  })
})
