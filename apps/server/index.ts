import { bootstrapAdaptiveAssets } from "../../packages/adaptive/bootstrap.js";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Store } from "../../packages/persistence/index.js";
import { createApp } from "./app.js";
import { Supervisor } from "../../packages/runtime/supervisor.js";
import { probeCodex } from "../../packages/runtime/adapter.js";
import { WorkService } from "../../packages/workflow/service.js";
import { OptimizationService } from "../../packages/optimization/index.js";
import { acquireController } from "../../packages/runtime/recovery.js";
import { AdaptiveRuntime } from "../../packages/adaptive/runtime.js";
import { AdaptiveEngine } from "../../packages/adaptive/engine.js";

const dataDir =
  process.env.AI_WORK_OS_DATA_DIR ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
    "AIWorkOS",
  );
mkdirSync(dataDir, { recursive: true });
const tokenPath = join(dataDir, "access-token");
if (!existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = readFileSync(tokenPath, "utf8").trim();
if (!token) throw new Error("访问令牌为空，请检查本机配置");
const port = Number(process.env.AI_WORK_OS_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("无效的AI_WORK_OS_PORT");
const store = new Store(join(dataDir, "state.db"));
const releaseController = acquireController(store);
const runtime = probeCodex();
const service = new WorkService(store, runtime);
const supervisor = new Supervisor(
  store,
  service,
  dataDir,
  process.env.AI_WORK_OS_CODEX ?? "codex",
);
supervisor.start();
bootstrapAdaptiveAssets(store);
const adaptiveRuntime = new AdaptiveRuntime(store, dataDir);
const adaptive = new AdaptiveEngine(store, undefined, adaptiveRuntime.executor(), adaptiveRuntime.planner());
adaptive.recover();
let adaptiveBusy = false;
const adaptiveTimer = setInterval(() => {
  if (adaptiveBusy) return;
  adaptiveBusy = true;
  void adaptive.tick().catch((error) => console.error("Adaptive scheduler error", error))
    .finally(() => { adaptiveBusy = false; });
}, 1000);
const optimization = new OptimizationService(store, dataDir, runtime);
const optimizationTimer = setInterval(() => {
  try {
    optimization.tick();
  } catch (error) {
    console.error("Optimization scheduler error", error);
  }
}, 30000);
const server = createApp(store, token, service, dataDir, adaptive, adaptiveRuntime).listen(
  port,
  "127.0.0.1",
  () => {
    console.log(
      `AI Work OS: http://127.0.0.1:${port}\nData: ${dataDir}\nAccess token file: ${tokenPath}`,
    );
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      clearInterval(optimizationTimer);
      clearInterval(adaptiveTimer);
      adaptive.close();
      void Promise.all([supervisor.close(), adaptiveRuntime.close()])
        .then(() => {
          releaseController();
          store.close();
          process.exit(0);
        })
        .catch((error) => {
          console.error(
            "Shutdown could not confirm all writers stopped",
            error,
          );
          process.exit(2);
        });
    }),
  );
