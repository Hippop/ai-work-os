import type { DatabaseSync } from "node:sqlite";

export const LATEST_SCHEMA_VERSION = 2;

export type MigrationHooks = {
  beforeCommit?: (targetVersion: number) => void;
};

/**
 * Synchronous, transactional SQLite migration runner.
 * Any failure rolls back the active step so the database stays at the prior version
 * or reaches the complete target version atomically.
 */
export function migrateDatabase(
  db: DatabaseSync,
  targetVersion = LATEST_SCHEMA_VERSION,
  hooks?: MigrationHooks,
): number {
  const currentVersion = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (currentVersion > targetVersion) {
    throw new Error(`Unsupported database schema version: ${currentVersion}`);
  }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

  if (currentVersion < 1 && targetVersion >= 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities(
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY(kind,id)
        );
        CREATE TABLE IF NOT EXISTS events(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          data TEXT NOT NULL,
          UNIQUE(run_id,seq)
        );
        CREATE TABLE IF NOT EXISTS idempotency(
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          digest TEXT NOT NULL,
          response TEXT NOT NULL,
          PRIMARY KEY(scope,key)
        );
        CREATE TABLE IF NOT EXISTS outbox(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL
        );
      `);
      hooks?.beforeCommit?.(1);
      db.exec("PRAGMA user_version=1; COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  if (currentVersion < 2 && targetVersion >= 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_drafts(
          id TEXT PRIMARY KEY,
          project_id TEXT,
          task_id TEXT,
          revision INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_graph_drafts_project_task
          ON graph_drafts(project_id, task_id);

        CREATE TABLE IF NOT EXISTS compiled_plans(
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          digest TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compiled_plans_draft
          ON compiled_plans(draft_id, revision, digest);

        CREATE TABLE IF NOT EXISTS canvas_layouts(
          id TEXT PRIMARY KEY,
          graph_id TEXT NOT NULL,
          viewer_key TEXT NOT NULL DEFAULT 'default',
          revision INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_canvas_layouts_graph
          ON canvas_layouts(graph_id, viewer_key);

        CREATE TABLE IF NOT EXISTS plan_changes(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          status TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_changes_run
          ON plan_changes(run_id, status);

        CREATE TABLE IF NOT EXISTS result_validity(
          id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_result_validity_inv
          ON result_validity(invocation_id, plan_revision);

        CREATE TABLE IF NOT EXISTS context_manifests(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_manifests_lookup
          ON context_manifests(run_id, node_id, invocation_id);

        CREATE TABLE IF NOT EXISTS workspace_access(
          workspace_id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          mode TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          status TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_access_owner
          ON workspace_access(owner, epoch);

        CREATE TABLE IF NOT EXISTS agent_sessions(
          id TEXT PRIMARY KEY,
          run_id TEXT,
          process_state TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_run
          ON agent_sessions(run_id, process_state);

        CREATE TABLE IF NOT EXISTS interventions(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          review_state TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_interventions_run
          ON interventions(run_id, review_state);

        CREATE TABLE IF NOT EXISTS effect_records(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          action_key TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_effect_records_run_action
          ON effect_records(run_id, action_key);

        CREATE TABLE IF NOT EXISTS knowledge_relations(
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_relations_pair
          ON knowledge_relations(source_id, target_id, relation_type);
      `);
      // Backfill existing V3.1 Phase-1 canvas_layout rows from entities.
      const legacyLayouts = db
        .prepare("SELECT id, data FROM entities WHERE kind = 'canvas_layout'")
        .all() as { id: string; data: string }[];
      const insertLayout = db.prepare(
        `INSERT INTO canvas_layouts(id, graph_id, viewer_key, revision, data)
         VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET graph_id=excluded.graph_id, viewer_key=excluded.viewer_key, revision=excluded.revision, data=excluded.data`,
      );
      for (const row of legacyLayouts) {
        const parsed = JSON.parse(row.data) as {
          id?: string;
          graphId?: string;
          viewerKey?: string;
          revision?: number;
        };
        insertLayout.run(
          row.id,
          parsed.graphId ?? parsed.id ?? row.id,
          parsed.viewerKey ?? "default",
          Number(parsed.revision ?? 0),
          row.data,
        );
      }
      hooks?.beforeCommit?.(2);
      db.exec("PRAGMA user_version=2; COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  return Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
}
