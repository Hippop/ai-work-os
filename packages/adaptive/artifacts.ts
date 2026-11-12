import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { DomainError } from "../domain/index.js";

export function artifactDigest(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
    throw new DomainError(
      "artifact_invalid",
      "工件必须是 16 MiB 以内的普通文件",
      422,
    );
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function captureArtifactDigests(
  paths: string[],
): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => {
      // Invalid paths remain inaccessible at the HTTP boundary and cannot be accepted.
      try {
        return [path, artifactDigest(path)];
      } catch {
        return [path, ""];
      }
    }),
  );
}
export function verifyArtifact(path: string, expected?: string): Buffer {
  if (!expected)
    throw new DomainError(
      "artifact_unverified",
      "工件缺少原始摘要，请重新生成交付",
      409,
    );
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
      throw Error("invalid file");
    const content = readFileSync(path);
    if (createHash("sha256").update(content).digest("hex") !== expected)
      throw Error("digest mismatch");
    return content;
  } catch {
    throw new DomainError(
      "artifact_changed",
      "工件缺失或摘要已改变，不能下载或验收",
      409,
    );
  }
}
export function verifyArtifacts(result: {
  artifactRefs: string[];
  artifactDigests?: Record<string, string>;
}) {
  for (const path of result.artifactRefs)
    verifyArtifact(path, result.artifactDigests?.[path]);
}
