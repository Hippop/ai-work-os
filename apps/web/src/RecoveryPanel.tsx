import { useState } from "react";

type View = {
  epoch: string | null;
  subjectDigest: string | null;
  workspace: string | null;
  knownProcesses: { pid: number; alive: boolean }[];
  receipt: { stopped: boolean; containment: string; updatedAt: string } | null;
};
export function RecoveryPanel({
  runId,
  busy,
  api,
  act,
  refresh,
}: {
  runId: string;
  busy: boolean;
  api: <T = any>(path: string, data?: unknown) => Promise<T>;
  act: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [view, setView] = useState<View>(),
    [reason, setReason] = useState(""),
    [workerStopped, setWorkerStopped] = useState(false),
    [externalActionsReconciled, setExternalActionsReconciled] = useState(false);
  return (
    <section className="delivery">
      <h3>执行状态核对</h3>
      <p>
        服务会根据停止凭据尝试恢复。若凭据不完整，请先检查遗留进程、代码及外部动作，再记录人工核对结论。人工核对后，恢复执行会重新验证全部步骤。
      </p>
      <button
        className="quiet"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setWorkerStopped(false);
            setExternalActionsReconciled(false);
            setView(await api<View>(`/runs/${runId}/recovery`));
          })
        }
      >
        检查恢复条件
      </button>
      {view && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api(`/runs/${runId}/recovery`, {
                expectedEpoch: view.epoch,
                subjectDigest: view.subjectDigest,
                workerStopped,
                externalActionsReconciled,
                reason,
              });
              await refresh();
            });
          }}
        >
          <p className="muted">
            工作区：{view.workspace ?? "未绑定"}
            <br />
            停止凭据：{view.receipt?.stopped ? "已记录" : "未确认"}
          </p>
          <p>
            {view.knownProcesses.length
              ? view.knownProcesses
                  .map(
                    (p) =>
                      `进程 ${p.pid}：${p.alive ? "仍存活或无法核实" : "已退出"}`,
                  )
                  .join("；")
              : "缺少已知进程记录，需要人工检查"}
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              required
              checked={workerStopped}
              onChange={(e) => setWorkerStopped(e.target.checked)}
            />
            已确认旧执行及其遗留进程均已停止
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              required
              checked={externalActionsReconciled}
              onChange={(e) => setExternalActionsReconciled(e.target.checked)}
            />
            已核对外部动作及代码影响，确认可以重新执行
          </label>
          <label>
            核对依据
            <textarea
              value={reason}
              minLength={10}
              maxLength={10000}
              required
              onChange={(e) => setReason(e.target.value)}
              placeholder="记录检查对象、检查方式及外部动作处理结果"
            />
          </label>
          <button
            disabled={
              busy ||
              !view.subjectDigest ||
              view.knownProcesses.some((p) => p.alive) ||
              !workerStopped ||
              !externalActionsReconciled
            }
          >
            记录人工核对并解除写锁
          </button>
        </form>
      )}
    </section>
  );
}
