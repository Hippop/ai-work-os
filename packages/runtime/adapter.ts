import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Job } from "./protocol.js";

export const Result = z.object({
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  risks: z.array(z.string()),
});
export class UnconfirmedStop extends Error {}
export function probeCodex(command = process.env.AI_WORK_OS_CODEX ?? "codex") {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  return {
    id: "codex",
    available: result.status === 0,
    version: result.status === 0 ? result.stdout.trim() : null,
    capabilities: {
      jsonEvents: true,
      structuredOutput: true,
      resume: false,
      toolAudit: "partial",
      permissionEnforcement: "executor-sandbox",
    },
  };
}
export async function stopTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill",
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
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    onChild(child);
    let stdout = "",
      stderr = "",
      ended = false;
    const abort = (reason: string) => {
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
      if (!(error instanceof UnconfirmedStop)) onChild(null);
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
) {
  const schemaPath = join(job.outputDir, "result.schema.json"),
    resultPath = join(job.outputDir, `${key}.json`);
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["summary", "evidence", "risks"],
      properties: {
        summary: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
      },
    }),
  );
  const args = [
    ...job.commandPrefix,
    "exec",
    "--json",
    "--sandbox",
    key === "implement" ? "workspace-write" : "read-only",
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
  );
  writeFileSync(join(job.outputDir, `${key}.events.jsonl`), result.stdout);
  writeFileSync(join(job.outputDir, `${key}.stderr.txt`), result.stderr);
  if (result.code !== 0)
    throw new Error(
      `Agent ${key} exited with ${result.code}; see execution logs`,
    );
  return Result.parse(JSON.parse(readFileSync(resultPath, "utf8")));
}
