import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Event } from "../domain/index.js";

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new Error(`Unsupported database schema version: ${version}`);
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(run_id,seq));
      CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
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
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, JSON.stringify(value));
  }
  event(
    runId: string,
    type: string,
    payload: unknown,
    actor = "platform",
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
    };
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?)")
      .run(event.id, runId, event.seq, JSON.stringify(event));
    return event;
  }
  events(runId: string, after = 0): Event[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500",
        )
        .all(runId, after) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  close() {
    this.db.close();
  }
}
