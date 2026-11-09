import { join, resolve } from "node:path";
import { Store } from "../../packages/persistence/index.js";
import { WorkService } from "../../packages/workflow/service.js";
import { Supervisor } from "../../packages/runtime/supervisor.js";
import type { Run } from "../../packages/domain/index.js";
import type { Lease } from "../../packages/runtime/receipt.js";
const [root, mode] = process.argv.slice(2);
if (mode === "hang") process.env.AI_WORK_OS_FIXTURE_HANG = "implement";
const store = new Store(join(root, "state.db")),
  service = new WorkService(store, { available: true, version: "fixture" });
const project = service.createProject({
  name: "Recovery fixture",
  repositoryPath: join(root, "repo"),
  allowAgent: true,
  testCommand: {
    executable: process.execPath,
    args: [
      "-e",
      "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)",
    ],
  },
});
const task = service.createTask({
  title: "Recover fixture",
  objective: "Write 42 into answer.txt",
  projectId: project.id,
  acceptanceCriteria: ["answer.txt is 42"],
});
const run = service.start(
  task.id,
  service.prepare(task.id).preparationDigest,
  "crash-test",
);
const supervisor = new Supervisor(store, service, root, process.execPath, [
  resolve("tests/fixtures/agent.mjs"),
]);
if (mode === "before-dispatch") {
  const put = store.put.bind(store);
  store.put = (kind, value) => {
    if (kind === "workspace") process.exit(137);
    return put(kind, value);
  };
}
// Emulate lost IPC/result consumption, while the independent worker still persists real receipts.
if (mode === "lost-result") {
  supervisor.message = () => {};
  supervisor.closed = () => {};
}
supervisor.start();
const timer = setInterval(() => {
  const current = service.required<Run>("run", run.id),
    lease = store.get<Lease>("execution_lease", run.id);
  if (
    lease &&
    (mode !== "hang" ||
      current.steps.some(
        (s) => s.key === "implement" && s.status === "running",
      ))
  ) {
    clearInterval(timer);
    process.send?.({ runId: run.id, taskId: task.id, lease });
  }
}, 50);
