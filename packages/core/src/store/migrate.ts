import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { SCHEMA } from './schema.js'

/**
 * One change of tables that already exist (a new column, a changed constraint, moved data).
 * New tables need none: `schema.sql` creates what is missing on every open.
 */
export interface Migration {
  /** what it does, for the log and for whoever reads a failed upgrade */
  name: string
  /** SQL, run in one transaction together with the version bump */
  up: string
}

/**
 * In order, never edited or removed once released: entry `i` takes a database from schema
 * version `i + 1` to `i + 2`. `schema.sql` always describes the result of all of them, so a new
 * database is created at the latest version and runs none.
 */
export const MIGRATIONS: Migration[] = []

/** Version 1 is the schema as it was when versions began; every database before that is at it. */
export const BASE_VERSION = 1

export interface Migrated {
  from: number
  to: number
  /** copy of the database made before the first change; absent when nothing was changed */
  backup?: string
}

const version = (db: Database.Database) => db.pragma('user_version', { simple: true }) as number

/**
 * Bring a database to the schema this build writes. A database of a newer build is refused: an
 * older build would write rows the newer one no longer reads the same way. Before an existing
 * database is changed, a copy of it is put next to it (`<db>.before-v<N>`).
 */
export function migrate(
  db: Database.Database,
  dbPath: string,
  migrations: Migration[] = MIGRATIONS,
): Migrated {
  const latest = BASE_VERSION + migrations.length
  const found = version(db)
  if (found > latest)
    throw new Error(
      `${dbPath} has schema version ${found}, this tiller knows ${latest}: it was written by a newer tiller; upgrade tiller or restore the copy made before the upgrade`,
    )
  const fresh =
    found === 0 &&
    (
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as {
        n: number
      }
    ).n === 0
  db.exec(SCHEMA)
  // a new database is at the latest schema already; one from before versions began is at the base
  const from = fresh ? latest : Math.max(found, BASE_VERSION)
  if (found !== from) db.pragma(`user_version = ${from}`)
  if (from === latest) return { from, to: latest }
  let backup: string | undefined
  if (dbPath !== ':memory:' && dbPath !== '') {
    backup = `${dbPath}.before-v${latest}`
    // an earlier attempt that failed left the same copy: the oldest one is the one to keep
    if (!existsSync(backup)) db.prepare('VACUUM INTO ?').run(backup)
  }
  for (let v = from; v < latest; v++) {
    const m = migrations[v - BASE_VERSION] as Migration
    try {
      db.transaction(() => {
        db.exec(m.up)
        db.pragma(`user_version = ${v + 1}`)
      }).immediate()
    } catch (e) {
      throw new Error(
        `migration ${v} → ${v + 1} (${m.name}) failed, the database is unchanged at version ${v}${backup ? `, a copy from before the upgrade is at ${backup}` : ''}: ${(e as Error).message}`,
      )
    }
  }
  // tables a migration expects from schema.sql exist by now; anything it dropped stays dropped
  return { from, to: latest, backup }
}

export const schemaVersion = version
