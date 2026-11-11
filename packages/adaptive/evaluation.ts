import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../persistence/index.js";
import { DomainError, digest, type Task } from "../domain/index.js";
import { AssetService, checkSchema } from "./assets.js";
import type { AdaptiveRun } from "./engine.js";

const expectInput=z.object({
  field:z.string().regex(/^[a-zA-Z_][\w.]{0,159}$/),
  equals:z.union([z.string(),z.number().finite(),z.boolean(),z.null()]),
}).strict();
const caseInput=z.object({
  id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  input:z.record(z.string(),z.unknown()),
  assertions:z.array(expectInput).min(1).max(30),
}).strict();
const datasetInput=z.object({
  title:z.string().trim().min(3).max(160),
  capabilityName:z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(120),
  projectId:z.string().uuid().nullable().default(null),
  cases:z.array(caseInput).min(1).max(40),
}).strict();
const pairInput=z.object({
  caseId:z.string().min(1).max(64),
  baselineRunId:z.string().uuid(),baselineNodeId:z.string().min(1).max(50),
  candidateRunId:z.string().uuid(),candidateNodeId:z.string().min(1).max(50),
}).strict();
const evaluationInput=z.object({
  datasetId:z.string().uuid(),
  baselineRef:z.string().min(3).max(180),
  candidateRef:z.string().min(3).max(180),
  pairs:z.array(pairInput).min(1).max(40),
}).strict();
type Dataset=z.infer<typeof datasetInput> & {id:string;createdAt:string;digest:string};
type CaseResult={id:string;baselinePass:boolean;candidatePass:boolean;
  baselineInvocationId:string;candidateInvocationId:string;baselineOutputDigest:string;candidateOutputDigest:string};
type Evaluation={
  id:string;datasetId:string;datasetDigest:string;
  baselineRef:string;candidateRef:string;
  verdict:"passed"|"regression"|"inconclusive";
  cases:CaseResult[];regressions:string[];improvements:string[];
  createdAt:string;evidenceDigest:string;
};
function selectField(output:unknown,path:string):unknown {
  let cursor=output;
  for(const part of path.split(".")){
    if (!cursor||typeof cursor!=="object"||Array.isArray(cursor)||!Object.hasOwn(cursor,part))
      return undefined;
    cursor=(cursor as Record<string,unknown>)[part];
  }
  return cursor;
}
/**
 * Evidence-only paired regression check for already executed, recorded adaptive runs.
 * No new remote calls, financial charges, code writes, automatic promotion or rollback.
 */
export class AdaptiveEvaluationService {
  constructor(private store:Store,private assets=new AssetService(store)){}
  listDatasets(){return this.store.list<Dataset>("adaptive_eval_dataset");}
  listEvaluations(){return this.store.list<Evaluation>("adaptive_eval_result");}
  createDataset(input:unknown){
    const data=datasetInput.parse(input);
    if(data.projectId&&!this.store.get("project",data.projectId))
      throw new DomainError("evaluation_project_missing","评估项目不存在",404);
    if(new Set(data.cases.map((c)=>c.id)).size!==data.cases.length)
      throw new DomainError("evaluation_duplicate_case","评估样例 ID 重复",422);
    // Intentionally immutable: changing expected results requires a new dataset.
    const record:Dataset={...data,id:randomUUID(),createdAt:new Date().toISOString(),digest:digest(data)};
    this.store.transaction(()=>{
      this.store.put("adaptive_eval_dataset",record);
      this.store.event("evaluation:dataset:"+record.id,"evaluation.dataset.created",{
        datasetDigest:record.digest,caseCount:data.cases.length,capabilityName:data.capabilityName,
      },"user");
    });
    return record;
  }
  evaluate(input:unknown){
    const data=evaluationInput.parse(input);
    const dataset=this.store.get<Dataset>("adaptive_eval_dataset",data.datasetId);
    if(!dataset)throw new DomainError("evaluation_dataset_missing","数据集不存在",404);
    const baseline=this.assets.getCapability(data.baselineRef,false);
    const candidate=this.assets.getCapability(data.candidateRef,false);
    if(baseline.id===candidate.id||baseline.name!==candidate.name||
       baseline.name!==dataset.capabilityName)
      throw new DomainError("evaluation_capability_mismatch","必须比较同名能力的两个不同版本",422);
    if(baseline.status!=="published"||candidate.status!=="published")
      throw new DomainError("evaluation_version_unpublished","仅比较已发布能力的真实执行结果",422);
    if(!["none","read"].includes(baseline.sideEffect)||
       !["none","read"].includes(candidate.sideEffect))
      throw new DomainError("evaluation_read_only","回放评估只接受无外部副作用的能力",422);
    if(data.pairs.length!==dataset.cases.length ||
       new Set(data.pairs.map((p)=>p.caseId)).size!==data.pairs.length ||
       data.pairs.some((p)=>!dataset.cases.some((c)=>c.id===p.caseId)))
      throw new DomainError("evaluation_cases_incomplete","每个冻结样例必须有且仅有一对运行证据",422);
    const results:CaseResult[]=[];
    for(const c of dataset.cases){
      const pair=data.pairs.find((p)=>p.caseId===c.id)!;
      checkSchema(baseline.inputSchema,c.input);
      checkSchema(candidate.inputSchema,c.input);
      const evidence=(runId:string,nodeId:string,expectedRef:string)=>{
        const run=this.store.get<AdaptiveRun>("adaptive_run",runId);
        if(!run||!["awaiting_acceptance","done"].includes(run.status))
          throw new DomainError("evaluation_run_unavailable","证据运行必须已交付",422);
        const task=this.store.get<Task>("task",run.taskId);
        if(!task||task.projectId!==dataset.projectId)
          throw new DomainError("evaluation_project_scope","证据运行不属于数据集项目",403);
        if(run.nodeStates[nodeId]!=="succeeded"||
            run.snapshots[nodeId]?.capability.id!==expectedRef)
          throw new DomainError("evaluation_node_mismatch","运行未成功使用指定能力版本",422);
        const result=run.results[nodeId];
        const invocation=this.store.get<{inputDigest:string;status:string;id:string}>(
          "adaptive_invocation",result.invocationId);
        if(!invocation||invocation.status!=="succeeded"||invocation.inputDigest!==digest(c.input))
          throw new DomainError("evaluation_input_mismatch","运行输入与冻结样例不一致",422);
        const output=result.output;
        if(result.digest!==digest(output))
          throw new DomainError("evaluation_output_changed","运行结果摘要与原始值不一致",409);
        checkSchema(run.snapshots[nodeId].capability.outputSchema,output);
        return {output,invocationId:result.invocationId,outputDigest:result.digest};
      };
      const old=evidence(pair.baselineRunId,pair.baselineNodeId,baseline.id);
      const next=evidence(pair.candidateRunId,pair.candidateNodeId,candidate.id);
      const passed=(output:unknown)=>c.assertions.every((a)=>
        Object.is(selectField(output,a.field),a.equals));
      results.push({
        id:c.id,baselinePass:passed(old.output),candidatePass:passed(next.output),
        baselineInvocationId:old.invocationId,candidateInvocationId:next.invocationId,
        baselineOutputDigest:old.outputDigest,candidateOutputDigest:next.outputDigest,
      });
    }
    const regressions=results.filter((r)=>r.baselinePass&&!r.candidatePass).map((r)=>r.id);
    const improvements=results.filter((r)=>!r.baselinePass&&r.candidatePass).map((r)=>r.id);
    const verdict=results.some((r)=>!r.candidatePass)?"regression":
      improvements.length>0?"passed":"inconclusive";
    const evaluation:Evaluation={
      id:randomUUID(),datasetId:dataset.id,datasetDigest:dataset.digest,
      baselineRef:baseline.id,candidateRef:candidate.id,
      verdict,cases:results,regressions,improvements,
      createdAt:new Date().toISOString(),
      evidenceDigest:digest({datasetDigest:dataset.digest,results}),
    };
    this.store.transaction(()=>{
      this.store.put("adaptive_eval_result",evaluation);
      this.store.event("evaluation:"+evaluation.id,"evaluation.completed",{
        datasetId:dataset.id,baselineRef:baseline.id,candidateRef:candidate.id,
        verdict,regressions,improvements,evidenceDigest:evaluation.evidenceDigest,
      },"user");
    });
    return evaluation;
  }
}
