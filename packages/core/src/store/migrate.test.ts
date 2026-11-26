import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { BASE_VERSION, MIGRATIONS, type Migration, migrate, schemaVersion } from './migrate.js'

const STEPS: Migration[] = [
  { name: 'note on a repository', up: 'ALTER TABLE repos ADD COLUMN note TEXT' },
  { name: 'broken', up: 'ALTER TABLE no_such_table ADD COLUMN x TEXT' },
]

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

it('a new database starts at the latest version and runs no migration', () => {
  const db = new Database(':memory:')
  // the broken step would throw if it ran
  expect(migrate(db, ':memory:', STEPS)).toEqual({ from: 3, to: 3 })
  expect(schemaVersion(db)).toBe(3)
})

it('a database from before versions began is at the base; changes are applied once, after a copy', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tiller-migrate-')), 'tiller.db')
  const db = new Database(path)
  expect(migrate(db, path, [])).toEqual({ from: BASE_VERSION, to: BASE_VERSION })
  // as an old build left it: tables, no version
  db.pragma('user_version = 0')
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 't')").run()

  const one = STEPS.slice(0, 1)
  const done = migrate(db, path, one)
  expect(done).toEqual({ from: 1, to: 2, backup: `${path}.before-v2` })
  expect(columns(db, 'repos')).toContain('note')
  expect(schemaVersion(db)).toBe(2)
  // the copy is the database as it was
  const copy = new Database(`${path}.before-v2`, { readonly: true })
  expect(columns(copy, 'repos')).not.toContain('note')
  expect(copy.prepare('SELECT value FROM settings').pluck().get()).toBe('v')
  // opening again changes nothing
  expect(migrate(db, path, one)).toEqual({ from: 2, to: 2 })
})

it('a failed migration leaves the version where it was and says where the copy is', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tiller-migrate-')), 'tiller.db')
  const db = new Database(path)
  migrate(db, path, [])
  expect(() => migrate(db, path, STEPS)).toThrow(
    /migration 2 → 3 \(broken\) failed, the database is unchanged at version 2, a copy from before the upgrade is at .*before-v3/,
  )
  // the first step held, the second did not
  expect(schemaVersion(db)).toBe(2)
  expect(existsSync(`${path}.before-v3`)).toBe(true)
})

it('a database of a newer tiller is refused', () => {
  const db = new Database(':memory:')
  migrate(db, ':memory:', [])
  db.pragma('user_version = 7')
  expect(() => migrate(db, 'tiller.db', [])).toThrow(
    'tiller.db has schema version 7, this tiller knows 1',
  )
})

it('the released migrations run on a database from before versions began', () => {
  const db = new Database(':memory:')
  migrate(db, ':memory:', [])
  db.pragma('user_version = 0')
  db.prepare(
    "INSERT INTO repos (repo, config, added_at) VALUES ('a/b', 'c0-vanilla', 't'), ('a/c', 'c0-opus', 't'), ('a/d', 'mine', 't')",
  ).run()
  expect(migrate(db, ':memory:').to).toBe(BASE_VERSION + MIGRATIONS.length)
  expect(db.prepare('SELECT config FROM repos ORDER BY repo').pluck().all()).toEqual([
    'default',
    'opus',
    'mine',
  ])
})
