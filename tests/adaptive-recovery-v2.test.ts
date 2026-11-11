import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets, standardAdaptivePlan } from "../packages/adaptive/bootstrap.js";

test("controller recovery of interrupted read-only checkpoint waits for human decision, not irreconcilable side effects", () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const task = new WorkService(store).createTask({
      title: "Progress recovery", type: "diagnosis",
      objective: "Inspect diagnostic evidence", acceptanceCriteria: ["Evidence reviewed"],
    });
    const engine = new AdaptiveEngine(store);
    const run = engine.createRun(task.id, standardAdaptivePlan(task));
    const interrupted = engine.get(run.id);
    interrupted.nodeStates.collect = "succeeded";
    interrupted.nodeStates.hypothesize = "succeeded";
    interrupted.observationStates["after-hypotheses"] = "running";
    interrupted.status = "running";
    store.put("adaptive_run", interrupted);
    engine.recover();
    const recovered = engine.get(run.id);
    assert.equal(recovered.status, "waiting");
    assert.equal(recovered.observationStates["after-hypotheses"], "waiting");
    assert.equal(recovered.nodeStates.hypothesize, "succeeded");
    const resumed = engine.resolveWaiting(run.id, "after-hypotheses", {
      decision: "CONTINUE", reason: "A human reviewed the documented evidence",
    });
    assert.equal(resumed.status, "running");
    assert.ok(store.events(run.id).some((e) => e.type === "adaptive.recovery.required"));
  } finally { store.close(); }
});

test("multiple interrupted invocations require individual confirmations before any safe retry", () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const task = new WorkService(store).createTask({
      title: "Multi-invocation crash", type: "manual",
      objective: "Review two independent nodes", acceptanceCriteria: ["Both checked"],
    });
    const engine = new AdaptiveEngine(store);
    const plan = { nodes: [
      {id:"one",capabilityRef:"core.analyze@1.0.0",dependsOn:[],inputs:{objective:"One"},bindings:{}},
      {id:"two",capabilityRef:"core.design@1.0.0",dependsOn:[],inputs:{objective:"Two"},bindings:{}},
      {id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:["one","two"],inputs:{objective:"Done"},bindings:{}},
    ],observations:[],rationale:"Independent branches"};
    const run = engine.createRun(task.id, plan);
    const interrupted = engine.get(run.id);
    interrupted.nodeStates.one = "running";
    interrupted.nodeStates.two = "running";
    interrupted.status = "running";
    store.put("adaptive_run", interrupted);
    engine.recover();
    assert.equal(engine.get(run.id).status, "reconciling");
    engine.reconcileUncertain(run.id, "one", true,
      "Inspected child process and verified no external writes");
    assert.equal(engine.get(run.id).status, "reconciling");
    assert.throws(() => engine.retry(run.id, "one"), /未核对/);
    engine.reconcileUncertain(run.id, "two", true,
      "Confirmed that remaining process tree has stopped");
    assert.equal(engine.get(run.id).status, "waiting");
    engine.retry(run.id, "one");
    assert.equal(engine.get(run.id).nodeStates.one, "pending");
  } finally { store.close(); }
});

test("failed REPLAN stays retryable, cannot be manually bypassed, and never removes an already completed write", async () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const task = new WorkService(store).createTask({
      title: "Safe replan", type: "development",
      objective: "Add a feature safely", acceptanceCriteria: ["Tests and review pass"],
    });
    const base = standardAdaptivePlan(task);
    const operations = ["implement","test","review","deliver"];
    base.nodes = base.nodes.filter((node)=>operations.includes(node.id))
      .map((node,i,list)=>({ ...node, dependsOn:i?[list[i-1].id]:[] }));
    base.observations = [{id:"after-write", afterNode:"implement", on:["succeeded"],
      barrier:true, question:"Is a follow-up analysis required?", maxInvocations:1}];
    let makeInvalid = true;
    const engine = new AdaptiveEngine(store, new AssetService(store),
      async ({node})=>({output:{summary:node.id,evidence:[],risks:[]}}), {
      compose: async (_task,_catalog,_knowledge,previous) => {
        assert.ok(previous);
        if (makeInvalid) return {
          nodes:[{id:"deliver",capabilityRef:"core.deliver@1.0.0",dependsOn:[],
            inputs:{objective:"Wrongly bypass the completed write"},bindings:{}}],
          observations:[], rationale:"Invalid side-effect removal",
        };
        return { ...base, observations:[], nodes:[
          base.nodes[0],
          {id:"extra",capabilityRef:"core.analyze@1.0.0",dependsOn:["implement"],
            inputs:{objective:"Inspect modified code"},bindings:{}},
          {...base.nodes[1],dependsOn:["extra"]},
          base.nodes[2], base.nodes[3],
        ]};
      },
      evaluate: async ()=>({
        decision:"REPLAN",reason:"Need additional evidence",affectedNodeIds:["test"],
        evidenceRefs:["artifact://result"],
      }),
    });
    const run = engine.createRun(task.id,base);
    await engine.tick(); // writer completed and recorded in side-effect ledger
    assert.equal(engine.get(run.id).nodeStates.implement,"succeeded");
    await engine.tick(); // invalid replan must block
    assert.equal(engine.get(run.id).status,"waiting");
    assert.equal(engine.get(run.id).decisions["after-write"].decision,"REPLAN");
    assert.throws(()=>engine.resolveWaiting(run.id,"after-write",{
      decision:"CONTINUE",reason:"Skip the safety gate",
    }),/REPLAN/);
    makeInvalid = false;
    const revised = await engine.resumeReplan(run.id,"after-write");
    assert.equal(revised.planRevision,2);
    assert.equal(revised.nodeStates.implement,"succeeded");
    assert.equal(revised.nodeStates.extra,"pending");
    assert.equal(revised.status,"running");
    assert.equal(store.list<any>("adaptive_side_effect").filter((x)=>x.state==="confirmed").length,1);
    assert.equal(store.events(run.id).filter((e)=>e.type==="adaptive.plan.revised").length,1);
  } finally {store.close();}
});
