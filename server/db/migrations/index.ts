import type Database from 'better-sqlite3'
import { initialSql } from './0001-initial'

import { routingSql } from './0002-routing'

import { snapshotsSql } from './0003-snapshots'

import { accessSql } from './0004-access'

import { automationSql } from './0005-automation'

import { reportsSql } from './0006-reports'

import { infraSql } from './0007-infra'

import { portsPoeSql } from './0008-ports-poe'

import { roomsRoamingSql } from './0009-rooms-roaming'

const migrations = [{ version: 1, sql: initialSql }, { version: 2, sql: routingSql }, { version: 3, sql: snapshotsSql }, { version: 4, sql: accessSql }, { version: 5, sql: automationSql }, { version: 6, sql: reportsSql }, { version: 7, sql: infraSql }, { version: 8, sql: portsPoeSql }, { version: 9, sql: roomsRoamingSql }]

export function migrateDatabase(sqlite: Database.Database) {
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    const applied = new Set(sqlite.prepare<[], number>('SELECT version FROM _migrations').pluck().all())
    const latest = migrations.at(-1)?.version ?? 0
    if (Array.from(applied).some(version => version > latest)) {
      throw new Error('The Unifire database was migrated by a newer application version')
    }
    const insert = sqlite.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      sqlite.exec(migration.sql)
      insert.run(migration.version, Date.now())
    }
  }).immediate()
}
