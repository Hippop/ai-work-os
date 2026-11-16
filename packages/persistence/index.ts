import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Event } from "../domain/index.js";
import {
  LATEST_SCHEMA_VERSION,
  migrateDatabase,
  type MigrationHooks,
} from "./migrations.js";

export type EventEnvelopeOptions = {
  correlationId?: string;
  causationId?: string;
  planRevision?: number;
};

export type EventPage = {
  events: Event[];
  lastSeq: number;
  hasMore: boolean;
  snapshotRequired: boolean;
};

export class Store {
  db: DatabaseSync;
  schemaVersion: number;
  private depth = 0;

  constructor(
    path: string,
    targetVersion = LATEST_SCHEMA_VERSION,
    hooks?: MigrationHooks,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.schemaVersion = migrateDatabase(this.db, targetVersion, hooks);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0,
      savepoint = `nested_${this.depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise)
        throw new Error("Database transactions must be synchronous");
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      if (nested) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid DESC")
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }

  put<T extends { id: string }>(kind: string, value: T) {
    const serialized = JSON.stringify(value);
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, serialized);
    this.mirrorToDedicatedTable(kind, value, serialized);
  }

  private mirrorToDedicatedTable(
    kind: string,
    value: Record<string, unknown>,
    serialized: string,
  ) {
    if (this.schemaVersion < 2) return;
    const id = String(value.id);
    switch (kind) {
      case "graph_draft":
        this.db
          .prepare(
            `INSERT INTO graph_drafts(id,project_id,task_id,revision,data) VALUES(?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, task_id=excluded.task_id, revision=excluded.revision, data=excluded.data`,
          )
          .run(
            id,
            (value.projectId as string | null) ?? null,
            (value.taskId as string | null) ?? null,
            Number(value.revision ?? 1),
            serialized,
          );
        break;
      case "compiled_plan":
        this.db
          .prepare(
            `INSERT INTO compiled_plans(id,draft_id,revision,digest,data) VALUES(?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET draft_id=excluded.draft_id, revision=excluded.revision, digest=excluded.digest, data=excluded.data`,
          )
          .run(
            id,
            String(value.draftId ?? ""),
            Number(value.draftRevision ?? 1),
            String(value.semanticDigest ?? ""),
            serialized,
          );
        break;
      case "canvas_layout":
        this.db
          .prepare(
            `INSERT INTO canvas_layouts(id,graph_id,viewer_key,revision,data) VALUES(?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET graph_id=excluded.graph_id, viewer_key=excluded.viewer_key, revision=excluded.revision, data=excluded.data`,
          )
          .run(
            id,
            String(value.graphId ?? id),
            String(value.viewerKey ?? "default"),
            Number(value.revision ?? 0),
            serialized,
          );
        break;
      case "plan_change":
        this.db
          .prepare(
            `INSERT INTO plan_changes(id,run_id,status,data) VALUES(?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, status=excluded.status, data=excluded.data`,
          )
          .run(
            id,
            String(value.runId ?? ""),
            String(value.status ?? "pending"),
            serialized,
          );
        break;
      case "result_validity":
        this.db
          .prepare(
            `INSERT INTO result_validity(id,invocation_id,plan_revision,data) VALUES(?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET invocation_id=excluded.invocation_id, plan_revision=excluded.plan_revision, data=excluded.data`,
          )
          .run(
            id,
            String(value.invocationId ?? ""),
            Number(value.assessedAtRevision ?? 1),
            serialized,
          );
        break;
      case "context_manifest":
        this.db
          .prepare(
            `INSERT INTO context_manifests(id,run_id,node_id,invocation_id,data) VALUES(?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, node_id=excluded.node_id, invocation_id=excluded.invocation_id, data=excluded.data`,
          )
          .run(
            id,
            String(value.runId ?? ""),
            String(value.nodeId ?? ""),
            String(value.invocationId ?? ""),
            serialized,
          );
        break;
      case "workspace_access":
        this.db
          .prepare(
            `INSERT INTO workspace_access(workspace_id,owner,mode,epoch,status,data) VALUES(?,?,?,?,?,?)
             ON CONFLICT(workspace_id) DO UPDATE SET owner=excluded.owner, mode=excluded.mode, epoch=excluded.epoch, status=excluded.status, data=excluded.data`,
          )
          .run(
            String(value.workspaceId ?? id),
            String(value.owner ?? ""),
            String(value.mode ?? "read-only"),
            Number(value.epoch ?? 0),
            String(value.status ?? "released"),
            serialized,
          );
        break;
      case "agent_session":
        this.db
          .prepare(
            `INSERT INTO agent_sessions(id,run_id,process_state,data) VALUES(?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, process_state=excluded.process_state, data=excluded.data`,
          )
          .run(
            id,
            (value.runId as string | null) ?? null,
            String(value.processState ?? "creating"),
            serialized,
          );
        break;
      case "intervention":
        this.db
          .prepare(
            `INSERT INTO interventions(id,run_id,review_state,data) VALUES(?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, review_state=excluded.review_state, data=excluded.data`,
          )
          .run(
            id,
            String(value.runId ?? ""),
            String(value.reviewState ?? "pending"),
            serialized,
          );
        break;
      case "effect_record":
        this.db
          .prepare(
            `INSERT INTO effect_records(id,run_id,action_key,data) VALUES(?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, action_key=excluded.action_key, data=excluded.data`,
          )
          .run(
            id,
            String(value.runId ?? ""),
            String(value.actionKey ?? ""),
            serialized,
          );
        break;
      case "knowledge_relation":
        this.db
          .prepare(
            `INSERT INTO knowledge_relations(id,source_id,target_id,relation_type,data) VALUES(?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id, target_id=excluded.target_id, relation_type=excluded.relation_type, data=excluded.data`,
          )
          .run(
            id,
            String(value.sourceId ?? ""),
            String(value.targetId ?? ""),
            String(value.relationType ?? ""),
            serialized,
          );
        break;
    }
  }

  event(
    runId: string,
    type: string,
    payload: unknown,
    actor = "platform",
    meta?: EventEnvelopeOptions,
  ): Event {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run_id=?",
      )
      .get(runId) as { seq: number };
    const event: Event = {
      id: randomUUID(),
      runId,
      seq: row.seq,
      type,
      actor,
      at: new Date().toISOString(),
      payload,
      ...(meta?.correlationId ? { correlationId: meta.correlationId } : {}),
      ...(meta?.causationId ? { causationId: meta.causationId } : {}),
      ...(meta?.planRevision !== undefined
        ? { planRevision: meta.planRevision }
        : {}),
    };
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?)")
      .run(event.id, runId, event.seq, JSON.stringify(event));
    return event;
  }

  events(runId: string, after = 0, limit = 500): Event[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(runId, after, limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }

  lastSeq(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run_id=?")
      .get(runId) as { seq: number };
    return Number(row.seq ?? 0);
  }

  eventsPage(runId: string, after = 0, limit = 200): EventPage {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const totalMax = this.lastSeq(runId);
    const minRow = this.db
      .prepare("SELECT MIN(seq) AS minSeq FROM events WHERE run_id=?")
      .get(runId) as { minSeq: number | null };
    const minSeq = minRow.minSeq === null ? null : Number(minRow.minSeq);
    if (after > totalMax || (minSeq !== null && after > 0 && after + 1 < minSeq)) {
      return {
        events: [],
        lastSeq: totalMax,
        hasMore: false,
        snapshotRequired: true,
      };
    }
    const rows = this.events(runId, after, safeLimit + 1);
    const hasMore = rows.length > safeLimit;
    const events = hasMore ? rows.slice(0, safeLimit) : rows;
    return {
      events,
      lastSeq: events.length ? events[events.length - 1].seq : totalMax,
      hasMore,
      snapshotRequired: false,
    };
  }

  idempotencyGet(
    scope: string,
    key: string,
  ): { digest: string; response: string } | undefined {
    return this.db
      .prepare("SELECT digest, response FROM idempotency WHERE scope=? AND key=?")
      .get(scope, key) as { digest: string; response: string } | undefined;
  }

  idempotencyPut(
    scope: string,
    key: string,
    digest: string,
    response: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO idempotency(scope,key,digest,response) VALUES(?,?,?,?) ON CONFLICT(scope,key) DO NOTHING",
      )
      .run(scope, key, digest, response);
  }

  close() {
    this.db.close();
  }
}
