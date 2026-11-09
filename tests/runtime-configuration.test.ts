import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../packages/runtime/adapter.js";
test("configuration drift is rejected before starting an executor or producing artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiwork-config-"));
  let spawned = false;
  try {
    await assert.rejects(
      runAgent(
        {
          runId: "test",
          epoch: "test",
          workspace: root,
          outputDir: root,
          command: process.execPath,
          commandPrefix: [],
          objective: "No execution",
          criteria: [],
          testCommand: { executable: process.execPath, args: [] },
          deadline: Date.now() + 1000,
          runtimeConfigurationDigest: "deliberately-invalid-config-digest",
        },
        "analyze",
        "Do not execute",
        () => {
          spawned = true;
        },
      ),
      /configuration changed/,
    );
    assert.equal(spawned, false);
    assert.equal(existsSync(join(root, "result.schema.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
