import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { createApp } from "../apps/server/app.js";
import { AssetService } from "../packages/adaptive/assets.js";
import { AdaptiveEngine } from "../packages/adaptive/engine.js";
import { McpRegistry, renderMcpConfig, isolatedCodexHome } from "../packages/adaptive/mcp.js";

test("published MCP server restricts tools by exact allowlist; write tools fail closed", () => {
  const store = new Store(":memory:");
  try {
    const registry = new McpRegistry(store);
    const server = registry.register({
      name: "docs", description: "Read-only docs tools",
      transport: { type: "stdio", executable: "/bin/echo", args: ["hello"] },
      exposedTools: ["search", "read", "delete"],
      readOnlyTools: ["search", "read"],
    });
    assert.throws(() => registry.resolve([{ server:"docs", actions:["read"] }], null), /未发布/);
    registry.publish(server.id);
    const r = registry.resolve([{ server: "docs", actions: ["search"] }], null);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].enabledTools, ["search"]);
    assert.throws(() => registry.resolve([{server:"docs",actions:["delete"]}],null),/写入工具/);
    assert.throws(() => registry.resolve([{server:"docs",actions:["unknown"]}],null),/不在已发布目录/);
    assert.throws(() => registry.resolve([{server:"docs",actions:["read"]},{server:"docs",actions:["search"]}],null),/授权重复/);
    const config = renderMcpConfig(r);
    assert.match(config, /enabled_tools = \["search"\]/);
    assert.doesNotMatch(config, /delete/);
    assert.doesNotMatch(config, /disabled_tools/);
    registry.revoke(server.id);
    assert.throws(() => registry.resolve([{server:"docs",actions:["read"]}],null), /未发布/);
  } finally { store.close(); }
});

test("profile MCP tools must be registered, published and read-only; project scopes are enforced", () => {
  const store = new Store(":memory:");
  try {
    const project = new WorkService(store).createProject({
      name:"MCP project", repositoryPath: process.cwd(), allowAgent:true, testCommand:{executable:"true",args:[]},
    });
    const registry = new McpRegistry(store), assets = new AssetService(store);
    registry.publish(registry.register({
      name: "project-docs", description: "Project docs",
      projectId: project.id, transport: {type:"http",url:"https://docs.example.com/mcp"},
      exposedTools: ["search"], readOnlyTools: ["search"],
    }).id);
    const profile = assets.createProfile({
      name:"project.read",version:"1.0.0",projectId:project.id,
      executor:"agent",agent:"codex",workspaceMode:"read-only",
      mcpGrants:[{server:"project-docs",actions:["search"]}],
    });
    assert.equal(assets.publishProfile(profile.id).status,"published");
    assert.throws(() => registry.resolve([{server:"project-docs",actions:["search"]}],null),/不属于当前项目/);
    const cap=assets.createCapability({
      name:"docs.read",version:"1.0.0",title:"Docs",description:"Query docs",
      inputSchema:{type:"object",properties:{objective:{type:"string"}},required:["objective"],additionalProperties:false},
      outputSchema:{type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false},
      profileRef:profile.id,
    });
    assets.validateCapability(cap.id,"Read-only tool verified");
    assets.publishCapability(cap.id);
    const deliverProfile=assets.publishProfile(assets.createProfile({
      name:"docs.delivery",version:"1.0.0",executor:"builtin",
    }).id);
    const deliver=assets.createCapability({
      name:"docs.deliver",version:"1.0.0",title:"Delivery",description:"Delivery",
      inputSchema:cap.inputSchema,outputSchema:cap.outputSchema,profileRef:deliverProfile.id,tags:["deliver"],
    });
    assets.validateCapability(deliver.id,"Known output");assets.publishCapability(deliver.id);
    const engine=new AdaptiveEngine(store,assets);
    assert.throws(()=>engine.validate({nodes:[
      {id:"docs",capabilityRef:cap.id,dependsOn:[],inputs:{objective:"Read"},bindings:{}},
      {id:"deliver",capabilityRef:deliver.id,dependsOn:["docs"],inputs:{objective:"Deliver"},bindings:{}},
    ]},null),/配置不属于当前项目/);
  } finally { store.close(); }
});

test("temporary Codex home copies only auth, emits isolated MCP catalog and disposes securely", () => {
  const dir=mkdtempSync(join(tmpdir(),"aiwork-mcp-test-"));
  try {
    const auth=join(dir,"auth-home");
    mkdirSync(auth);
    writeFileSync(join(auth,"auth.json"),'{"tokens":"private"}');
    writeFileSync(join(auth,"config.toml"),'[mcp_servers.unapproved]\ncommand = "dangerous"\n');
    const configured=isolatedCodexHome(renderMcpConfig([]),{authHome:auth,tempRoot:dir});
    const config=readFileSync(join(configured.dir,"config.toml"),"utf8");
    assert.doesNotMatch(config,/unapproved/);
    assert.equal(configured.env.CODEX_HOME,configured.dir);
    assert.equal(readFileSync(join(configured.dir,"auth.json"),"utf8"),'{"tokens":"private"}');
    assert.equal(statSync(configured.dir).mode & 0o777,0o700);
    assert.equal(statSync(join(configured.dir,"auth.json")).mode & 0o777,0o600);
    configured.dispose();
    assert.equal(existsSync(configured.dir),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("authenticated MCP API registers/publishes server for profile use",async()=>{
  const store=new Store(":memory:");
  try{
    const app=createApp(store,"secret"),auth={Authorization:"Bearer secret"};
    await request(app).get("/api/v2/mcp-servers").expect(401);
    const s=(await request(app).post("/api/v2/mcp-servers").set(auth).send({
      name:"read-docs",description:"Read docs",
      transport:{type:"http",url:"https://example.org/mcp"},
      exposedTools:["search"],readOnlyTools:["search"],
    }).expect(201)).body;
    await request(app).post("/api/v2/mcp-servers/"+s.id+"/publish").set(auth).send({}).expect(200);
    const list=(await request(app).get("/api/v2/mcp-servers").set(auth).expect(200)).body;
    assert.equal(list[0].status,"published");
    assert.deepEqual(list[0].readOnlyTools,["search"]);
  }finally{store.close();}
});
