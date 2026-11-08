import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

export function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function createWorkspace(
  root: string,
  repo: string,
  runId: string,
  base: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^[a-f0-9]{40,64}$/.test(base))
    throw new Error("Invalid workspace identity");
  mkdirSync(root, { recursive: true });
  const workspace = join(root, runId);
  git(repo, ["worktree", "add", "--detach", workspace, base]);
  return workspace;
}
export function workspaceFiles(workspace: string) {
  const paths = git(workspace, [
    "ls-files",
    "-z",
    "-c",
    "-o",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean);
  return [...new Set(paths)].sort().map((path) => {
    const absolute = resolve(workspace, path),
      rel = relative(workspace, absolute);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Workspace path escaped");
    // Deleted tracked files are represented by an explicit marker.
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return { path, deleted: true, hash: null };
    }
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Unsupported artifact file: ${path}`);
    if (stat.size > 16 * 1024 * 1024)
      throw new Error(`Artifact exceeds limit: ${path}`);
    return {
      path,
      deleted: false,
      hash: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    };
  });
}
export function workspaceDigest(workspace: string) {
  return createHash("sha256")
    .update(JSON.stringify(workspaceFiles(workspace)))
    .digest("hex");
}
export function exportChanges(workspace: string, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const patch = execFileSync(
    "git",
    ["-C", workspace, "diff", "--binary", "HEAD"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(join(outputDir, "changes.patch"), patch);
  const untracked = git(workspace, [
    "ls-files",
    "-z",
    "-o",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean);
  const files = workspaceFiles(workspace);
  writeFileSync(
    join(outputDir, "untracked.json"),
    JSON.stringify(
      untracked.map((path) => ({
        path,
        contentBase64: readFileSync(resolve(workspace, path)).toString(
          "base64",
        ),
      })),
      null,
      2,
    ),
  );
  writeFileSync(join(outputDir, "files.json"), JSON.stringify(files, null, 2));
  return ["changes.patch", "untracked.json", "files.json"];
}
