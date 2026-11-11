import { DomainError } from "../domain/index.js";
import { Store } from "../persistence/index.js";
import type { Profile } from "./assets.js";

export type BillingRates = {
  inputUsdPerMillion: number; outputUsdPerMillion: number;
  reservedInputTokens: number; reservedOutputTokens: number;
};
export type CostRecord = {
  id:string; runId:string; profileRef:string; model:string|null;
  state:"reserved"|"settled"|"unverified"|"overrun";
  reservedMicroUsd:number; actualMicroUsd?:number;
  inputTokens?:number; outputTokens?:number;
  createdAt:string; completedAt?:string;
};
function cost(tokens:number,rate:number) {
  return Math.ceil(tokens * rate);
}
function verifiedNumber(value:number) {
  return Number.isSafeInteger(value) && value >= 0;
}
export function estimatedCostMicro(rates:BillingRates) {
  return cost(rates.reservedInputTokens,rates.inputUsdPerMillion)
    + cost(rates.reservedOutputTokens,rates.outputUsdPerMillion);
}
export class BudgetService {
  constructor(private store:Store) {}
  list(runId:string) {
    return this.store.list<CostRecord>("adaptive_cost").filter((c)=>c.runId===runId);
  }
  /**
   * Reservation is an admission estimate, NOT a network/provider hard cap.
   * Concurrent invocations reserve inside a SQLite transaction.
   */
  reserve(runId:string,invocationId:string,profile:Profile,runBudgetUsd:number|null) {
    if(profile.executor!=="agent")return null;
    const rates=profile.billing;
    if(!rates) {
      if(runBudgetUsd!==null)
        throw new DomainError("billing_rates_missing","有运行费用预算时，Agent Profile 必须配置明确的单价与预留 token",422);
      return null;
    }
    return this.store.transaction(()=>{
      const existing=this.store.get<CostRecord>("adaptive_cost",invocationId);
      if(existing)throw new DomainError("cost_duplicate","能力调用费用记录重复",409);
      const quote=estimatedCostMicro(rates);
      if(quote>Math.floor(profile.maxCostUsd*1e6))
        throw new DomainError("invocation_budget_exceeded","单能力费用预留超过 Profile 预算",422);
      const records=this.list(runId);
      if(records.some((r)=>["unverified","overrun"].includes(r.state)))
        throw new DomainError("cost_unverified","已有未确认费用或超支记录，禁止继续派发付费调用",409);
      const committed=records.reduce((sum,r)=>sum+
        (r.state==="reserved" ? r.reservedMicroUsd : (r.actualMicroUsd??r.reservedMicroUsd)),0);
      if(runBudgetUsd!==null && committed+quote>Math.floor(runBudgetUsd*1e6))
        throw new DomainError("run_cost_budget_exceeded","运行费用预留超过总预算",422);
      const record:CostRecord = {
        id:invocationId,runId,profileRef:profile.id,model:profile.model??null,
        state:"reserved",reservedMicroUsd:quote,createdAt:new Date().toISOString(),
      };
      this.store.put("adaptive_cost",record);
      this.store.event(runId,"adaptive.cost.reserved",{
        invocationId,profileRef:profile.id,reservedMicroUsd:quote,
        runBudgetUsd,
      });
      return record;
    });
  }
  settle(invocationId:string,usage:{inputTokens?:number;outputTokens?:number}|undefined,
    profile:Profile,runBudgetUsd:number|null) {
    const existing=this.store.get<CostRecord>("adaptive_cost",invocationId);
    if(!existing)return null;
    if(!usage||!verifiedNumber(usage.inputTokens??NaN)||
        !verifiedNumber(usage.outputTokens??NaN))
      return this.unverified(invocationId,"model_usage_missing");
    const rates=profile.billing;
    if(!rates)return this.unverified(invocationId,"pricing_missing");
    return this.store.transaction(()=>{
      const record=this.store.get<CostRecord>("adaptive_cost",invocationId)!;
      if(record.state!=="reserved")throw new DomainError("cost_state","费用已结算或状态不可更改",409);
      const inputTokens=usage.inputTokens!,outputTokens=usage.outputTokens!;
      const actualMicroUsd=cost(inputTokens,rates.inputUsdPerMillion)
        +cost(outputTokens,rates.outputUsdPerMillion);
      const others=this.list(record.runId).filter((r)=>r.id!==invocationId)
        .reduce((sum,r)=>sum+(r.state==="reserved"?r.reservedMicroUsd:
          (r.actualMicroUsd??r.reservedMicroUsd)),0);
      const overrun=actualMicroUsd>record.reservedMicroUsd ||
        actualMicroUsd>Math.floor(profile.maxCostUsd*1e6) ||
        (runBudgetUsd!==null && others+actualMicroUsd>Math.floor(runBudgetUsd*1e6));
      const updated:CostRecord={...record,state:overrun?"overrun":"settled",
        actualMicroUsd,inputTokens,outputTokens,completedAt:new Date().toISOString()};
      this.store.put("adaptive_cost",updated);
      this.store.event(record.runId,overrun?"adaptive.cost.overrun":"adaptive.cost.settled",{
        invocationId,actualMicroUsd,reservedMicroUsd:record.reservedMicroUsd,inputTokens,outputTokens,
      });
      return updated;
    });
  }
  unverified(invocationId:string,reason:string) {
    return this.store.transaction(()=>{
      const record=this.store.get<CostRecord>("adaptive_cost",invocationId);
      if(!record||record.state!=="reserved")return record??null;
      const updated:CostRecord={...record,state:"unverified",completedAt:new Date().toISOString()};
      this.store.put("adaptive_cost",updated);
      this.store.event(record.runId,"adaptive.cost.unverified",{invocationId,reason});
      return updated;
    });
  }
  /** An operator may record verified provider token usage; it never creates a false zero charge. */
  reconcile(invocationId:string,inputTokens:number,outputTokens:number,profile:Profile,runBudgetUsd:number|null,note:string) {
    if (note.trim().length < 20) throw new DomainError("cost_reconciliation_evidence","必须提供供应商用量核对依据",422);
    if(!verifiedNumber(inputTokens)||!verifiedNumber(outputTokens))
      throw new DomainError("cost_usage_invalid","费用核对需要有效的 token 数",422);
    return this.store.transaction(()=>{
      const existing=this.store.get<CostRecord>("adaptive_cost",invocationId);
      if(!existing||existing.state!=="unverified")
        throw new DomainError("cost_reconciliation_state","费用不在待核对状态",422);
      this.store.put("adaptive_cost",{...existing,state:"reserved"});
      const result=this.settle(invocationId,{inputTokens,outputTokens},profile,runBudgetUsd);
      this.store.event(existing.runId,"adaptive.cost.reconciled",{invocationId,inputTokens,outputTokens,note},"user");
      return result;
    });
  }
}
