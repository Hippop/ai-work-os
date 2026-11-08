import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Store } from "../../packages/persistence/index.js";
import { createApp } from "./app.js";

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
const store = new Store(join(dataDir, "state.db"));
const server = createApp(store, token).listen(4310, "127.0.0.1", () => {
  console.log(
    `AI Work OS: http://127.0.0.1:4310\nData: ${dataDir}\nAccess token file: ${tokenPath}`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
