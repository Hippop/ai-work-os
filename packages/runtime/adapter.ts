import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, isAbsolute, delimiter, extname } from "node:path";
import { z } from "zod";
import type { Job } from "./protocol.js";
import { DiagnosisResult } from "../diagnosis/index.js";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";

export const Result = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  risks: z.array(z.string()),
});
export class UnconfirmedStop extends Error {}
export function executablePath(command: string, cwd = process.cwd()) {
  if (process.platform !== "win32") return command;
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\"))
    return resolve(cwd, command);
  // Never implicitly search an agent-controlled working directory.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, extname(command) ? command : `${command}.exe`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`Executable was not found on the absolute PATH: ${command}`);
}
const managed = new WeakMap<
  ChildProcess,
  { stopPath: string; proofPath: string; stopped?: boolean }
>();
const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function runtimeSettings() {
  let content = "";
  try {
    content = readFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
      "utf8",
    );
  } catch {}
  const root = content.split(/^\[/m)[0],
    model =
      process.env.AI_WORK_OS_CODEX_MODEL ??
      root.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ??
      null,
    reasoning =
      root.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  return {
    model,
    reasoning,
    configurationDigest: createHash("sha256")
      .update(JSON.stringify({ content, model, reasoning }))
      .digest("hex"),
  };
}
export function probeCodex(command = process.env.AI_WORK_OS_CODEX ?? "codex") {
  let result: ReturnType<typeof spawnSync> | undefined;
  try {
    result = spawnSync(executablePath(command), ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
  } catch {}
  return {
    id: "codex",
    available: result?.status === 0,
    version: result?.status === 0 ? String(result.stdout).trim() : null,
    ...runtimeSettings(),
    capabilities: {
      jsonEvents: true,
      structuredOutput: true,
      resume: false,
      toolAudit: "partial",
      permissionEnforcement: "executor-sandbox",
    },
  };
}
export function stopTree(child: ChildProcess): Promise<void> {
  const pending = stopping.get(child);
  if (pending) return pending;
  const result = stopChild(child);
  stopping.set(child, result);
  return result;
}
async function stopChild(child: ChildProcess) {
  const group = managed.get(child);
  if (group) {
    if (child.exitCode === null && child.signalCode === null) {
      writeFileSync(group.stopPath, "stop");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new UnconfirmedStop("Job termination was not acknowledged")),
          15000,
        );
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (!group.stopped && readFileSync(group.proofPath, "utf8") !== "stopped")
      throw new UnconfirmedStop("Missing process containment stop proof");
    return;
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      killer.once("error", reject);
      killer.once("exit", (code) =>
        code === 0 || child.exitCode !== null
          ? resolve()
          : reject(new Error("Could not confirm process-tree stop")),
      );
    });
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new UnconfirmedStop("Process termination was not acknowledged"),
            ),
          10000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
export function execute(
  command: string,
  args: string[],
  cwd: string,
  deadline: number,
  onChild: (child: ChildProcess | null) => void,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let requestDir: string | undefined;
    let executable = command,
      arguments_ = args;
    if (process.platform === "win32") {
      requestDir = mkdtempSync(join(tmpdir(), "aiwork-process-"));
      const requestPath = join(requestDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify({
          command: executablePath(command, cwd),
          args,
          cwd,
          parentPid: process.pid,
          stopPath: join(requestDir, "stop"),
          proofPath: join(requestDir, "stopped"),
        }),
        { mode: 0o600 },
      );
      executable = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      arguments_ = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-job.ps1", import.meta.url)),
        requestPath,
      ];
    }
    const child = spawn(executable, arguments_, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (requestDir)
      managed.set(child, {
        stopPath: join(requestDir, "stop"),
        proofPath: join(requestDir, "stopped"),
      });
    onChild(child);
    let stdout = "",
      stderr = "",
      ended = false;
    let abortReason: Error | undefined;
    const abort = (reason: string) => {
      if (abortReason) return;
      abortReason = new Error(reason);
      void stopTree(child).then(
        () => finish(new Error(reason)),
        (error) => finish(new UnconfirmedStop(String(error))),
      );
    };
    const timer = setTimeout(
      () => abort("Execution deadline exceeded"),
      Math.max(1, deadline - Date.now()),
    );
    const finish = (error?: Error, code = -1) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      error ??= abortReason;
      if (requestDir) {
        try {
          if (readFileSync(join(requestDir, "stopped"), "utf8") !== "stopped")
            throw new Error("Invalid stop proof");
          const group = managed.get(child);
          if (group) group.stopped = true;
        } catch {
          error = new UnconfirmedStop(
            "Process containment stop proof is missing",
          );
        }
      }
      if (!(error instanceof UnconfirmedStop)) {
        onChild(null);
        managed.delete(child);
        if (requestDir) rmSync(requestDir, { recursive: true, force: true });
      }
      error ? reject(error) : resolve({ stdout, stderr, code });
    };
    child.stdout!.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) abort("Output limit exceeded");
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) abort("Error output limit exceeded");
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code ?? -1));
  });
}
export async function runAgent(
  job: Job,
  key: string,
  prompt: string,
  onChild: (child: ChildProcess | null) => void,
  operation = key,
) {
  if (
    job.runtimeConfigurationDigest &&
    runtimeSettings().configurationDigest !== job.runtimeConfigurationDigest
  )
    throw new Error(
      "Runtime configuration changed after input snapshot; reprepare the task",
    );
  const schemaPath = join(job.outputDir, "result.schema.json"),
    resultPath = join(job.outputDir, `${key}.json`);
  const diagnostic = job.taskType === "diagnosis" && operation === "conclude";
  function strictSchema(value: any): any {
    if (Array.isArray(value)) return value.map(strictSchema);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "default")
        .map(([key, v]) => [key, strictSchema(v)]),
    );
    if (result.properties) {
      result.required = Object.keys(result.properties);
      result.additionalProperties = false;
    }
    return result;
  }
  const schema = diagnostic
    ? strictSchema(z.toJSONSchema(DiagnosisResult))
    : null;
  writeFileSync(
    schemaPath,
    JSON.stringify(
      schema ?? {
        type: "object",
        additionalProperties: false,
        required: ["summary", "evidence", "risks"],
        properties: {
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
        },
      },
    ),
  );
  const args = [
    ...job.commandPrefix,
    "exec",
    ...(job.model ? ["--model", job.model] : []),
    ...(job.modelReasoning
      ? ["-c", `model_reasoning_effort=${JSON.stringify(job.modelReasoning)}`]
      : []),
    "--json",
    "--sandbox",
    operation === "implement" ? "workspace-write" : "read-only",
    "-C",
    job.workspace,
    "--output-schema",
    schemaPath,
    "-o",
    resultPath,
    prompt,
  ];
  const result = await execute(
    job.command,
    args,
    job.workspace,
    job.deadline,
    onChild,
    { env: job.env },
  );
  writeFileSync(join(job.outputDir, `${key}.events.jsonl`), result.stdout);
  writeFileSync(join(job.outputDir, `${key}.stderr.txt`), result.stderr);
  if (result.code !== 0)
    throw new Error(
      `Agent ${key} exited with ${result.code}; see execution logs`,
    );
  const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  return diagnostic ? DiagnosisResult.parse(parsed) : Result.parse(parsed);
}
