import { Store } from "../persistence/index.js";
import { z } from "zod";
import type { AdaptiveRun } from "./engine.js";
import type { CostRecord } from "./budget.js";

const filterInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(5000).default(2000),
});
type Invocation = {
  id: string; runId: string; nodeId: string; status: string; startedAt: string;
  finishedAt?: string; durationMs?: number; modelUsage?: { inputTokens?: number; outputTokens?: number };
};
type Event = { id: string; runId: string; type: string; at: string; payload: unknown };
const terminal = new Set(["done", "failed", "cancelled", "awaiting_acceptance"]);
/**
 * Analysis is read-only. No model calls, profiling hooks or self-modifying changes.
 * Only aggregated, non-secret metadata is exposed; large prompt/tool outputs stay in artifacts.
 */
export class AdaptiveObservability {
  constructor(private store: Store) {}
  report(input: unknown = {}) {
    const { days, limit } = filterInput.parse(input);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const runs = this.store.list<AdaptiveRun>("adaptive_run").filter((run) => run.createdAt >= since);
    const runIds = new Set(runs.map((run) => run.id));
    const costRecords = this.store.list<CostRecord>("adaptive_cost")
      .filter((c) => runIds.has(c.runId));
    const invocations = this.store.list<Invocation>("adaptive_invocation")
      .filter((inv) => runIds.has(inv.runId) && inv.startedAt >= since)
      .slice(0, limit);
    const events = (this.store.db.prepare(
      "SELECT data FROM events WHERE json_extract(data,'$.at')>=? AND run_id NOT LIKE 'asset:%' ORDER BY rowid DESC LIMIT ?"
    ).all(since, limit) as {data:string}[]).map((row)=>JSON.parse(row.data) as Event)
      .filter((event)=>runIds.has(event.runId));
    const totals: Record<string, number> = {};
    for (const run of runs) totals[run.status] = (totals[run.status] ?? 0) + 1;
    const byCapability = new Map<string, {
      capabilityRef: string; invoked: number; succeeded: number;
      failed: number; uncertain: number; totalDurationMs: number;
      measured: number; inputTokens: number; outputTokens: number;
    }>();
    for (const invocation of invocations) {
      const run = runs.find((r)=>r.id===invocation.runId);
      const name = run?.snapshots[invocation.nodeId]?.capability.id ?? "unknown";
      const entry = byCapability.get(name) ?? {
        capabilityRef:name,invoked:0,succeeded:0,failed:0,uncertain:0,
        totalDurationMs:0,measured:0,inputTokens:0,outputTokens:0,
      };
      entry.invoked++;
      if(invocation.status==="succeeded")entry.succeeded++;
      if(invocation.status==="failed")entry.failed++;
      if(["uncertain","reconciled"].includes(invocation.status))entry.uncertain++;
      const duration = invocation.durationMs ??
        (invocation.finishedAt ? Date.parse(invocation.finishedAt)-Date.parse(invocation.startedAt) : NaN);
      if (Number.isFinite(duration) && duration >= 0) {entry.totalDurationMs+=duration;entry.measured++;}
      entry.inputTokens+=(invocation.modelUsage?.inputTokens??0);
      entry.outputTokens+=(invocation.modelUsage?.outputTokens??0);
      byCapability.set(name,entry);
    }
    const eventCounts: Record<string,number>={};
    for(const event of events)eventCounts[event.type]=(eventCounts[event.type]??0)+1;
    const capabilities=[...byCapability.values()].map((entry)=>({
      capabilityRef:entry.capabilityRef,
      invoked:entry.invoked,succeeded:entry.succeeded,failed:entry.failed,uncertain:entry.uncertain,
      averageDurationMs:entry.measured?Math.round(entry.totalDurationMs/entry.measured):null,
      inputTokens:entry.inputTokens,outputTokens:entry.outputTokens,
    })).sort((a,b)=>b.invoked-a.invoked);
    const recommendations=capabilities.filter((c)=>c.invoked>=3 && (c.failed+c.uncertain)/c.invoked>=0.3)
      .map((c)=>({
        capabilityRef:c.capabilityRef,severity:"review",
        reason:"最近运行中失败或不确定的比例较高；建议检查 Skill、模型、输入输出契约及工具权限",
        evidence:{attempts:c.invoked,failed:c.failed,uncertain:c.uncertain},
      }));
    const counted=Object.values(totals).reduce((a,b)=>a+b,0);
    return {
      range:{since,days,runCount:counted,sampledInvocations:invocations.length,eventCount:events.length,limit},
      runStatuses:totals,completed:runs.filter((r)=>terminal.has(r.status)).length,
      invocations:capabilities,events:eventCounts,
      checkpoints:{triggered:eventCounts["adaptive.observation.started"]??0,
        decided:eventCounts["adaptive.observation.decided"]??0,
        blocked:eventCounts["adaptive.observation.blocked"]??0},
      replans:eventCounts["adaptive.plan.revised"]??0,
      knowledgeRetrievals: this.countKnowledgeEvents(since,limit),
      modelCosts: {
        pricedCalls:costRecords.length,
        settledUsd:costRecords.filter((c)=>["settled","overrun"].includes(c.state))
          .reduce((sum,c)=>sum+(c.actualMicroUsd??0),0)/1_000_000,
        pendingReserveUsd:costRecords.filter((c)=>c.state==="reserved")
          .reduce((sum,c)=>sum+c.reservedMicroUsd,0)/1_000_000,
        unverified:costRecords.filter((c)=>c.state==="unverified").length,
        overruns:costRecords.filter((c)=>c.state==="overrun").length,
      },
      recommendations,
      limitations:[
        "Token usage is included only when the underlying executor provided usage data",
        "USD totals are profile-configured estimates, not provider invoices or hard spending caps",
        "Counts cover retained local SQLite records only; no external telemetry is inferred",
        "Recommendations require review and never alter capability versions automatically",
      ],
    };
  }
  private countKnowledgeEvents(since:string,limit:number) {
    // Searches can use task:* or knowledge:search event streams.
    const rows=this.store.db.prepare(
      "SELECT data FROM events WHERE (run_id LIKE 'task:%' OR run_id='knowledge:search') AND json_extract(data,'$.at')>=? LIMIT ?"
    ).all(since,limit) as {data:string}[];
    return rows.map((row)=>JSON.parse(row.data) as Event)
      .filter((event)=>event.type==="knowledge.retrieved").length;
  }
}
