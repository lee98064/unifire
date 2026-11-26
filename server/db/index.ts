import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrateDatabase } from './migrations'
import * as schema from './schema'

export function createDatabase(filename = ':memory:') {
  const sqlite = new Database(filename)
  try {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    migrateDatabase(sqlite)
    return { db: drizzle(sqlite, { schema }), sqlite }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export type Db = ReturnType<typeof createDatabase>['db']

let connection: ReturnType<typeof createDatabase> | undefined

export function initializeDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  connection ??= createDatabase(join(dataDir, 'unifire.db'))
}

export function useDb(): Db {
  if (!connection) throw new Error('The Unifire database has not been initialized')
  return connection.db
}

export function closeDb() {
  const closing = connection
  connection = undefined
  if (!closing) return
  try { closing.sqlite.pragma('wal_checkpoint(PASSIVE)') } finally { closing.sqlite.close() }
}
