import { useState } from "react";
import type { Run } from "../../../packages/domain/index";
export function PlanEditor({
  run,
  submit,
}: {
  run: Run;
  submit: (nodes: unknown, reason: string) => Promise<void>;
}) {
  const [nodes, setNodes] = useState(
      JSON.stringify(
        run.manifest.activePlan ??
          (run.manifest.context as { plan: unknown })?.plan ??
          [],
        null,
        2,
      ),
    ),
    [reason, setReason] = useState("");
  return (
    <details>
      <summary>重新规划与接纳人工修改</summary>
      <p>
        旧计划与执行记录会保留，所有步骤和验证证据重新计算；不会扩大项目授权。
      </p>
      <label>
        变更原因与人工修改说明
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </label>
      <label>
        步骤JSON
        <textarea
          rows={16}
          value={nodes}
          onChange={(e) => setNodes(e.target.value)}
        />
      </label>
      <button onClick={() => void submit(nodes, reason)}>
        校验并保存新计划
      </button>
    </details>
  );
}
