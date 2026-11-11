import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { bootstrapAdaptiveAssets, standardAdaptivePlan } from "../packages/adaptive/bootstrap.js";

test("task-defined ordered stages are compiler-enforced even if planner ignores them", () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const work = new WorkService(store), engine = new AdaptiveEngine(store);
    const task = work.createTask({
      type:"development", title:"Ordered stages", objective:"Change service with tests",
      acceptanceCriteria:["Tests pass"], flowRequirements:{
        mode:"compose", instructions:"Keep design before tests",
        stages:[
          {operation:"design",title:"Design first"},
          {operation:"test",title:"Test after design"},
          {operation:"review",title:"Review last"},
        ],
      },
    });
    const valid = standardAdaptivePlan(task);
    assert.doesNotThrow(()=>engine.validate(valid,null,task.id));
    const wrong = work.createTask({
      type:"development",title:"Contradictory stages",objective:"Inspect test order",
      acceptanceCriteria:["Proper order"], flowRequirements:{
        mode:"compose", instructions:"The test stage must come before design",
        stages:[
          {operation:"test",title:"Test before design"},
          {operation:"design",title:"Design after test"},
        ],
      },
    });
    assert.throws(()=>engine.validate(standardAdaptivePlan(wrong),null,wrong.id),/用户指定的阶段及顺序/);
  } finally { store.close(); }
});

test("task-authored graph must retain exact required node keys and direct edges", () => {
  const store = new Store(":memory:");
  try {
    bootstrapAdaptiveAssets(store);
    const task = new WorkService(store).createTask({
      type:"development", title:"Strict graph", objective:"Analyze then design and deliver",
      acceptanceCriteria:["Review passes"], flowRequirements:{
        mode:"graph", instructions:"Keep direct analyze -> design and review -> deliver links",
        nodes:[
          {key:"analyze",operation:"analyze",title:"Analyze requirements",dependsOn:[]},
          {key:"design",operation:"design",title:"Design solution",dependsOn:["analyze"]},
          {key:"deliver",operation:"deliver",title:"Deliver change",dependsOn:["review"]},
        ],
      },
    });
    const engine = new AdaptiveEngine(store), plan = standardAdaptivePlan(task);
    assert.doesNotThrow(()=>engine.validate(plan,null,task.id));
    const changed = structuredClone(plan);
    changed.nodes.find((n)=>n.id==="deliver")!.dependsOn=["test"];
    assert.throws(()=>engine.validate(changed,null,task.id),/用户指定的图节点或直接依赖|质量/);
  } finally { store.close(); }
});
