import { Service, type Context } from 'cordis'
import Database from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrations.js'

export interface DatabaseConfig {
  path: string
}

export interface DatabaseHealth {
  ready: boolean
  path: string
  migrationVersion: number
}

declare module 'cordis' {
  interface Context {
    database: DatabaseService
  }
}

function resolveDatabasePath(ctx: Context, path: string): string {
  if (path === ':memory:' || isAbsolute(path)) return path
  if (ctx.baseUrl?.startsWith('file:')) {
    return fileURLToPath(new URL(path, ctx.baseUrl))
  }
  return resolve(path)
}

export class DatabaseService extends Service {
  private connection: Database.Database | undefined
  private ready = false
  readonly path: string

  constructor(ctx: Context, public config: DatabaseConfig) {
    super(ctx, 'database')
    if (!config.path) throw new TypeError('database.path is required')
    this.path = resolveDatabasePath(ctx, config.path)
  }

  async *[Service.init]() {
    if (this.path !== ':memory:') {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    }

    const database = new Database(this.path)
    this.connection = database
    database.pragma('foreign_keys = ON')
    database.pragma('journal_mode = WAL')
    database.pragma('busy_timeout = 5000')
    runMigrations(database)
    this.ready = true

    yield () => {
      this.ready = false
      this.connection = undefined
      database.close()
    }
  }

  get db(): Database.Database {
    if (!this.connection || !this.ready) throw new Error('database is not ready')
    return this.connection
  }

  transaction<T>(callback: () => T): T {
    return this.db.transaction(callback).immediate()
  }

  health(): DatabaseHealth {
    const migrationVersion = this.connection
      ? (this.connection.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version
      : 0
    return { ready: this.ready, path: this.path, migrationVersion }
  }
}

export default DatabaseService
