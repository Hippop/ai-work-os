import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Store } from "../packages/persistence/index.js";
import { ExternalSkillService } from "../packages/external-skills/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { createApp } from "../apps/server/app.js";

const markdown = (name: string, body: string) =>
  "---\nname: " + name + "\ndescription: " + name + " helper\n---\n" + body + "\n";

test("external skills remain path references and freeze only instructions per run", () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-skills-"));
  const store = new Store(":memory:");
  try {
    const folder = join(root, ".agents", "skills", "code-review");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "SKILL.md");
    writeFileSync(file, markdown("code-review", "Check edge cases"));
    writeFileSync(join(folder, "helper.js"), "console.log('external asset')");
    const links = new ExternalSkillService(store);
    const result = links.register({ path: root });
    assert.equal(result.found, 1);
    const entry = links.skills()[0];
    assert.equal(entry.name, "code-review");
    assert.equal(store.list("resource").length, 0);
    assert.equal(store.get<any>("external_skill", entry.id)?.content, undefined);
    const work = new WorkService(store);
    const taskInput = {
      title: "Review",
      objective: "Inspect behavior",
      type: "manual",
      acceptanceCriteria: ["Reviewed"],
      externalSkillIds: [entry.id],
    };
    const one = work.createTask(taskInput);
    const prepared = work.prepare(one.id);
    const first = work.start(one.id, prepared.preparationDigest, "initial");
    assert.match((first.manifest.context as any).skills[0].content, /Check edge cases/);
    assert.equal((first.manifest.context as any).skills[0].external.directoryPath, folder);
    writeFileSync(file, markdown("code-review", "Check concurrency"));
    const two = work.createTask(taskInput);
    const pending = work.prepare(two.id);
    writeFileSync(file, markdown("code-review", "Check security"));
    assert.throws(() => work.start(two.id, pending.preparationDigest, "outdated"), /准备已过期/);
    const second = work.start(two.id, work.prepare(two.id).preparationDigest, "fresh");
    assert.match((second.manifest.context as any).skills[0].content, /Check security/);
    assert.match((first.manifest.context as any).skills[0].content, /Check edge cases/);
    assert.equal(store.list("resource").length, 0);
    assert.equal(links.scan(result.source!.id).found, 1);
    assert.equal(links.skills()[0].id, entry.id);
    rmSync(folder, { recursive: true });
    assert.equal(links.scan(result.source!.id).missing, 1);
    const three = work.createTask(taskInput);
    assert.throws(() => work.prepare(three.id), /外部Skill不可用/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan rejects missing roots, skips malformed skills, and HTTP API requires auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-skills-api-"));
  const store = new Store(":memory:");
  try {
    mkdirSync(join(root, "invalid"));
    writeFileSync(join(root, "invalid", "SKILL.md"), "bad frontmatter");
    mkdirSync(join(root, "valid"));
    writeFileSync(join(root, "valid", "SKILL.md"),
      "---\nname: valid\ndescription: >-\n  Multiline\n  description\n---\nDo useful work");
    const app = createApp(store, "local-token");
    const auth = { Authorization: "Bearer local-token" };
    await request(app).get("/api/v1/external-skills").expect(401);
    await request(app).post("/api/v1/skill-sources").set(auth)
      .send({ path: "relative" }).expect(422);
    const scan = (await request(app).post("/api/v1/skill-sources").set(auth)
      .send({ path: root }).expect(201)).body;
    assert.equal(scan.found, 1);
    assert.ok(scan.warnings.some((s: string) => s.includes("invalid")));
    const entries = (await request(app).get("/api/v1/external-skills").set(auth).expect(200)).body;
    assert.equal(entries.length, 1);
    assert.match(entries[0].description, /Multiline description/);
    const again = (await request(app).post("/api/v1/skill-sources/" + scan.source.id + "/scan")
      .set(auth).send({}).expect(200)).body;
    assert.equal(again.found, 1);
    assert.equal((await request(app).get("/api/v1/skill-sources").set(auth).expect(200)).body.length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux scan does not follow symbolic links outside authorized root", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-linux-skills-"));
  const other = mkdtempSync(join(tmpdir(), "aiwork-external-symlink-"));
  const store = new Store(":memory:");
  try {
    const inside = join(root, "review");
    mkdirSync(inside);
    writeFileSync(join(inside, "SKILL.md"), markdown("review", "Check code"));
    writeFileSync(join(other, "SKILL.md"), markdown("outside", "Private helper"));
    symlinkSync(other, join(root, "outside"));
    const links = new ExternalSkillService(store);
    const result = links.register({ path: root });
    assert.equal(result.found, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("符号链接")));
    assert.deepEqual(links.skills().map((skill) => skill.name), ["review"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
