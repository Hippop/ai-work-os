import { digest } from "../domain/index.js";

export type ToolAudit = {
  kind: string; name: string; inputDigest: string | null; outputDigest: string | null;
};
/** Stores metadata and hashes only; never store raw command arguments or MCP output in the database. */
export function summarizeCodexEvents(jsonl: string): {
  usage?: { inputTokens: number; outputTokens: number };
  tools: ToolAudit[];
} {
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const tools: ToolAudit[] = [];
  for (const line of jsonl.split("\n").slice(0,2000)) {
    if (!line.trim() || line.length > 200000) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "turn.completed") {
      const raw=event.usage ?? event.item?.usage;
      if (raw) {
        const inputTokens=Number(raw.input_tokens ?? raw.inputTokens);
        const outputTokens=Number(raw.output_tokens ?? raw.outputTokens);
        if (Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
            Number.isSafeInteger(outputTokens) && outputTokens >= 0)
          usage={inputTokens,outputTokens};
      }
    }
    if (event?.type !== "item.completed") continue;
    const item=event.item;
    if (!item || !["command_execution","mcp_tool_call","file_change","web_search"].includes(item.type))
      continue;
    const name=String(item.name ?? item.command?.split?.(" ")?.[0] ?? item.type).slice(0,120);
    tools.push({
      kind:item.type,name,
      inputDigest:item.arguments !== undefined || item.command !== undefined
        ? digest({arguments:item.arguments ?? null,command:item.command ?? null}) : null,
      outputDigest:item.output !== undefined ? digest(item.output) : null,
    });
  }
  return { usage, tools };
}
