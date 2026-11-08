/** Opt-in real model integration check. Creates and retains a temporary test repository and evidence. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../packages/persistence/index.js";
import { WorkService } from "../packages/workflow/service.js";
import { Supervisor } from "../packages/runtime/supervisor.js";
import { probeCodex } from "../packages/runtime/adapter.js";
import type { Run } from "../packages/domain/index.js";

const runtime = probeCodex();
if (!runtime.available) throw new Error("Codex CLI not available");
const root = mkdtempSync(join(tmpdir(), "aiwork-real-smoke-")),
  repo = join(root, "repo");
execFileSync("git", ["init", repo], { stdio: "ignore" });
writeFileSync(join(repo, "answer.txt"), "0");
for (const args of [
  ["add", "."],
  [
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-m",
    "base",
  ],
])
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
const store = new Store(join(root, "state.db")),
  service = new WorkService(store, runtime);
const supervisor = new Supervisor(
  store,
  service,
  root,
  process.env.AI_WORK_OS_CODEX ?? "codex",
);
const project = service.createProject({
  name: "Real Codex smoke",
  repositoryPath: repo,
  allowAgent: true,
  testCommand: {
    executable: process.execPath,
    args: [
      "-e",
      "if(require('fs').readFileSync('answer.txt','utf8').trim()!=='42')process.exit(1)",
    ],
  },
});
const task = service.createTask({
  title: "Codex execution smoke",
  objective:
    "Change answer.txt to contain exactly 42. This is a minimal fixture; no dependencies, commits or network are needed.",
  projectId: project.id,
  maxMinutes: 5,
  acceptanceCriteria: [
    "answer.txt contains 42 and deterministic verification passes",
  ],
});
const run = service.start(
  task.id,
  service.prepare(task.id).preparationDigest,
  "real-smoke",
);
console.log(JSON.stringify({ root, runId: run.id, runtime }));
supervisor.start();
let last = "";
try {
  const end = Date.now() + 330000;
  while (Date.now() < end) {
    const current = service.required<Run>("run", run.id),
      summary = `${current.status}: ${current.steps.map((s) => `${s.key}=${s.status}`).join(", ")}`;
    if (summary !== last) {
      console.log(summary);
      last = summary;
    }
    if (["succeeded", "failed", "reconciling"].includes(current.status)) {
      console.log(
        JSON.stringify({
          status: current.status,
          errors: store
            .events(run.id)
            .filter(
              (e) => e.type === "run.error" || e.type === "recovery.required",
            ),
          evidenceDirectory: join(root, "artifacts", run.id),
        }),
      );
      if (current.status !== "succeeded") process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await supervisor.close();
  store.close();
}
