import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/persistence/index.js";
import { AssetService } from "../packages/adaptive/assets.js";
function setup(){
 const store=new Store(":memory:"),assets=new AssetService(store);
 const older=assets.createKnowledge({name:"runtime.policy",version:"1.0.0",title:"Runtime policy",
   scope:"global",source:"User",content:"Retry after three seconds"});
 assets.publishKnowledge(older.id);
 const newer=assets.createKnowledge({name:"runtime.policy",version:"2.0.0",title:"Runtime policy",
   scope:"global",source:"User",content:"Retry after five seconds"});
 assets.publishKnowledge(newer.id);
 return {store,assets,older,newer};
}
test("one newest published version is selected instead of mixing contradictory knowledge",()=>{
 const {store,assets,older,newer}=setup();
 try{
  const hits=assets.retrieveKnowledge("Retry",null,null,"runtime.analyze");
  assert.equal(hits.length,1);
  assert.equal(hits[0].id,newer.id);
  assert.equal(hits[0].version,"2.0.0");
  assert.notEqual(hits[0].id,older.id);
 }finally{store.close();}
});
test("capability binding may intentionally pin an older version; two required versions are rejected",()=>{
 const {store,assets,older,newer}=setup();
 try{
  assets.bindKnowledge({knowledgeRef:older.id,capabilityName:"runtime.analyze",mode:"required"});
  const pinned=assets.retrieveKnowledge("Retry",null,null,"runtime.analyze");
  assert.deepEqual(pinned.map((k)=>k.id),[older.id]);
  assets.bindKnowledge({knowledgeRef:newer.id,capabilityName:"runtime.analyze",mode:"required"});
  assert.throws(()=>assets.retrieveKnowledge("Retry",null,null,"runtime.analyze"),/多个必需版本/);
 }finally{store.close();}
});
