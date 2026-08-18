import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up(database: Database.Database): void
}

export const coreMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'core-durable-domain',
    up(database) {
      database.exec(`
        CREATE TABLE automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          active_revision_id TEXT,
          activation_generation INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE automation_drafts (
          automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
          base_revision_id TEXT,
          source_json TEXT NOT NULL,
          presentation_json TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE automation_revisions (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          protocol_version INTEGER NOT NULL,
          source_json TEXT NOT NULL,
          presentation_json TEXT NOT NULL DEFAULT '{}',
          ir_version INTEGER NOT NULL,
          compiled_plan_json TEXT NOT NULL,
          dependency_manifest_json TEXT NOT NULL,
          contract_snapshot_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (automation_id, number)
        );

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id),
          revision_id TEXT NOT NULL REFERENCES automation_revisions(id),
          status TEXT NOT NULL CHECK (status IN (
            'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED'
          )),
          trigger_json TEXT NOT NULL,
          input_json TEXT NOT NULL,
          group_key TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );

        CREATE INDEX runs_dispatch_idx ON runs(status, created_at);
        CREATE INDEX runs_automation_idx ON runs(automation_id, created_at DESC);

        CREATE TABLE executions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          instruction_id TEXT NOT NULL,
          parent_execution_id TEXT REFERENCES executions(id),
          status TEXT NOT NULL CHECK (status IN (
            'RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED',
            'CANCELLING', 'CANCELLED', 'TIMED_OUT'
          )),
          resolved_input_json TEXT,
          output_json TEXT,
          wake_at TEXT,
          generation INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX executions_dispatch_idx ON executions(status, wake_at, updated_at);
        CREATE INDEX executions_run_idx ON executions(run_id, created_at);

        CREATE TABLE attempts (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED',
            'INTERRUPTED', 'OUTCOME_UNKNOWN'
          )),
          provider_ref TEXT NOT NULL,
          error_json TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          UNIQUE (execution_id, number)
        );

        CREATE TABLE run_events (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
      `)
    },
  },
  {
    version: 2,
    name: 'execution-block-reason',
    up(database) {
      database.exec(`
        ALTER TABLE executions ADD COLUMN blocked_reason TEXT;
        CREATE INDEX executions_blocked_idx ON executions(status, blocked_reason, updated_at);
      `)
    },
  },
  {
    version: 3,
    name: 'run-cancellation-intent',
    up(database) {
      database.exec(`
        ALTER TABLE runs ADD COLUMN cancel_reason TEXT;
        CREATE INDEX runs_cancelling_idx ON runs(status, created_at);
      `)
    },
  },
  {
    version: 4,
    name: 'durable-trigger-events',
    up(database) {
      database.exec(`
        CREATE TABLE trigger_events (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id),
          revision_id TEXT NOT NULL REFERENCES automation_revisions(id),
          activation_generation INTEGER NOT NULL,
          trigger_id TEXT NOT NULL,
          capability_id TEXT NOT NULL,
          capability_version INTEGER NOT NULL,
          event_id TEXT,
          subject TEXT,
          data_json TEXT NOT NULL,
          checkpoint_json TEXT,
          occurred_at TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX trigger_events_dedupe_idx
          ON trigger_events(revision_id, trigger_id, event_id)
          WHERE event_id IS NOT NULL;
        CREATE INDEX trigger_events_automation_idx
          ON trigger_events(automation_id, accepted_at DESC);
      `)
    },
  },
  {
    version: 5,
    name: 'connection-configs',
    up(database) {
      database.exec(`
        CREATE TABLE connections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          adapter_id TEXT NOT NULL,
          adapter_version INTEGER NOT NULL,
          config_json TEXT NOT NULL,
          credential_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          generation INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX connections_adapter_idx
          ON connections(adapter_id, adapter_version, enabled);
      `)
    },
  },
  {
    version: 6,
    name: 'encrypted-credentials',
    up(database) {
      database.exec(`
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type_id TEXT NOT NULL,
          type_version INTEGER NOT NULL,
          ciphertext BLOB NOT NULL,
          nonce BLOB NOT NULL,
          key_id TEXT NOT NULL,
          secret_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX credentials_type_idx
          ON credentials(type_id, type_version, updated_at DESC);
      `)
    },
  },
  {
    version: 7,
    name: 'resource-lifecycle',
    up(database) {
      database.exec(`
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size >= 0),
          digest TEXT NOT NULL,
          store_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('STAGED', 'COMMITTED', 'DELETING', 'GONE')),
          staged_expires_at TEXT,
          gc_after TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          gone_at TEXT
        );

        CREATE INDEX resources_gc_idx
          ON resources(state, staged_expires_at, gc_after);
        CREATE INDEX resources_digest_idx
          ON resources(digest, state);

        CREATE TABLE resource_owners (
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (resource_id, owner_type, owner_id)
        );

        CREATE INDEX resource_owners_owner_idx
          ON resource_owners(owner_type, owner_id);

        CREATE TABLE resource_leases (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
          holder TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX resource_leases_expiry_idx
          ON resource_leases(resource_id, expires_at);
      `)
    },
  },
]

export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[] = coreMigrations,
): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedRows = database
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>
  const applied = new Map(appliedRows.map(row => [row.version, row.name]))

  for (const migration of migrations) {
    const existingName = applied.get(migration.version)
    if (existingName && existingName !== migration.name) {
      throw new Error(
        `migration ${migration.version} was applied as ${existingName}, expected ${migration.name}`,
      )
    }
  }

  const apply = database.transaction((migration: Migration) => {
    migration.up(database)
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, new Date().toISOString())
  })

  let count = 0
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    apply.immediate(migration)
    count += 1
  }
  return count
}
