import { basename } from "node:path";
import { createHash } from "node:crypto";
import { DomainError, digest, type Event } from "../domain/index.js";
import { Store } from "../persistence/index.js";
import type { AdaptiveRun } from "./engine.js";
import type { CostRecord } from "./budget.js";

const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
type Invocation = {
  id:string;runId:string;nodeId:string;profileRef:string;
  planRevision:number;inputDigest:string;status:string;outputDigest?:string;
  startedAt:string;finishedAt?:string;durationMs?:number;
  knowledgeRefs?:{id:string;digest:string}[];
};
type SideEffect = {
  id:string;runId?:string|null;nodeId?:string|null;
  capabilityRef?:string;state:string;inputDigest:string;outputDigest?:string;
};
type PlanRevision = {
  id:string;runId:string;number:number;digest:string;reason:string;
};
type AuditEvent = {
  seq:number;id:string;type:string;actor:string;at:string;
  payloadDigest:string;chainHash:string;
};
function readAllEvents(store:Store,runId:string):Event[] {
  const result:Event[]=[];
  let after=0;
  for(;;){
    const page=store.events(runId,after);
    if(!page.length)break;
    if(page[0].seq<=after)throw new DomainError("audit_event_sequence","审计事件页不连续",409);
    result.push(...page);
    after=page.at(-1)!.seq;
    if(page.length<500)break;
    if(result.length>100000)
      throw new DomainError("audit_limit","单次运行审计记录超过导出上限",422);
  }
  return result;
}
/**
 * Read-only audit snapshot with a locally verifiable SHA-256 event chain.
 * It is NOT externally signed/immutable proof. Data can be modified by a DB administrator.
 * Avoid raw prompts, credentials, MCP arguments, outputs and artifact contents.
 */
export class AdaptiveAuditService {
  constructor(private store:Store){}
  exportRun(id:string){
    const run=this.store.get<AdaptiveRun>("adaptive_run",id);
    if(!run)throw new DomainError("audit_run_missing","运行不存在",404);
    const revisions=this.store.list<PlanRevision>("adaptive_plan_revision")
      .filter((x)=>x.runId===id)
      .sort((a,b)=>a.number-b.number)
      .map((x)=>({number:x.number,digest:x.digest,reason:x.reason}));
    const invocations=this.store.list<Invocation>("adaptive_invocation")
      .filter((x)=>x.runId===id)
      .sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id))
      .map((x)=>({
        id:x.id,nodeId:x.nodeId,planRevision:x.planRevision,
        profileRef:x.profileRef,inputDigest:x.inputDigest,outputDigest:x.outputDigest??null,
        status:x.status,startedAt:x.startedAt,finishedAt:x.finishedAt??null,
        durationMs:x.durationMs??null,
        knowledgeRefs:x.knowledgeRefs??[],
      }));
    const costs=this.store.list<CostRecord>("adaptive_cost")
      .filter((x)=>x.runId===id)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map((x)=>({
        invocationId:x.id,model:x.model,profileRef:x.profileRef,state:x.state,
        reservedMicroUsd:x.reservedMicroUsd,actualMicroUsd:x.actualMicroUsd??null,
        inputTokens:x.inputTokens??null,outputTokens:x.outputTokens??null,
      }));
    const sideEffects=this.store.list<SideEffect>("adaptive_side_effect")
      .filter((x)=>x.runId===id)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map((x)=>({
        invocationId:x.id,nodeId:x.nodeId??null,
        capabilityRef:x.capabilityRef??null,state:x.state,
        inputDigest:x.inputDigest,outputDigest:x.outputDigest??null,
      }));
    let chainHash=sha256("AIWorkOS:audit:v1:"+id);
    const events:AuditEvent[]=[];
    for(const event of readAllEvents(this.store,id)){
      if(event.seq!==events.length+1)
        throw new DomainError("audit_event_gap","运行审计存在事件序号缺失",409);
      const payloadDigest=digest(event.payload);
      chainHash=sha256(JSON.stringify({
        previous:chainHash,id:event.id,runId:event.runId,seq:event.seq,
        type:event.type,actor:event.actor,at:event.at,payloadDigest,
      }));
      events.push({
        seq:event.seq,id:event.id,type:event.type,actor:event.actor,
        at:event.at,payloadDigest,chainHash,
      });
    }
    const snapshot={
      format:"ai-work-os.adaptive-audit.v1",
      runId:id,taskId:run.taskId,runStatus:run.status,planRevision:run.planRevision,
      budgetUsd:run.budgetUsd??null,
      createdAt:run.createdAt,updatedAt:run.updatedAt,
      planRevisions:revisions,invocations,costs,sideEffects,events,
      artifacts:Object.entries(run.results).flatMap(([nodeId,result])=>result.artifactRefs.map((path)=>({
        nodeId,name:basename(path),sha256:result.artifactDigests?.[path]??null,
      }))),
      finalChainHash:chainHash,
      limitations:[
        "This snapshot is locally hashed but not externally signed or append-only.",
        "Payloads, model prompts and external MCP argument values are deliberately omitted.",
        "The snapshot covers one adaptive run; external provider records must be reconciled separately.",
      ],
    };
    return { ...snapshot, snapshotDigest:sha256(JSON.stringify(snapshot)) };
  }
}
