/**
 * Browser-safe canonical JSON serialization helper.
 * Preserves array order because sequence order is semantically significant unless explicitly pre-sorted by caller.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" +
    entries
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
      .join(",") +
    "}"
  );
}

export function capabilityDigestPayload(cap: {
  id: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sideEffect: string;
}) {
  return {
    id: cap.id,
    version: cap.version,
    inputSchema: cap.inputSchema,
    outputSchema: cap.outputSchema,
    sideEffect: cap.sideEffect,
  };
}

export function profileDigestPayload(profile: {
  id: string;
  version: string;
  executor: string;
  workspaceMode: string;
  workspaceSubdir?: string;
  skillIds?: string[];
}) {
  return {
    id: profile.id,
    version: profile.version,
    executor: profile.executor,
    workspaceMode: profile.workspaceMode,
    workspaceSubdir: profile.workspaceSubdir,
    skillIds: [...(profile.skillIds ?? [])].sort(),
  };
}

export async function sha256HexBrowser(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digestBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

