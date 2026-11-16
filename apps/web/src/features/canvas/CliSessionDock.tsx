import { useEffect, useRef, useState } from "react";
import type {
  AgentSession,
  InterventionRecord,
} from "../../../../../packages/graph/types";

type API = (
  path: string,
  data?: unknown,
  headers?: Record<string, string>,
  method?: string,
) => Promise<any>;

export function CliSessionDock({
  runId,
  revision,
  nodeId,
  api,
  interventions,
  sessions,
  onUpdated,
}: {
  runId: string;
  revision: number;
  nodeId?: string;
  api: API;
  interventions: InterventionRecord[];
  sessions: AgentSession[];
  onUpdated: () => Promise<void>;
}) {
  const [adapter, setAdapter] = useState<"codex" | "opencode">("codex");
  const [mode, setMode] = useState<"interactive-read" | "interactive-write">(
    "interactive-read",
  );
  const [selectedIv, setSelectedIv] = useState("");
  const [selectedSession, setSelectedSession] = useState("");
  const [outputChunks, setOutputChunks] = useState<
    { seq: number; stream: string; data: string }[]
  >([]);
  const [truncatedBefore, setTruncatedBefore] = useState(0);
  const [wsState, setWsState] = useState<"idle" | "connected" | "detached">("idle");
  const [isWriter, setIsWriter] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [inputText, setInputText] = useState("");
  const [adoptJson, setAdoptJson] = useState("{}");
  const [adoptNote, setAdoptNote] = useState("人工复核并接纳本次交互改动");
  const [wsDigest, setWsDigest] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);

  const visibleInterventions = nodeId
    ? interventions.filter((iv) => !iv.nodeId || iv.nodeId === nodeId)
    : interventions;

  useEffect(() => {
    if (!selectedIv && visibleInterventions.length > 0) {
      setSelectedIv(visibleInterventions[0].id);
    }
  }, [selectedIv, visibleInterventions]);

  const activeIv = visibleInterventions.find((iv) => iv.id === selectedIv);
  const activeSessions = activeIv
    ? sessions.filter((s) => s.interventionId === activeIv.id)
    : sessions;
  const activeSess = activeSessions.find((s) => s.id === selectedSession);

  useEffect(() => {
    if (!selectedSession && activeSessions.length > 0) {
      setSelectedSession(activeSessions[0].id);
    }
  }, [selectedSession, activeSessions]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [runId]);

  async function runAction(fn: () => Promise<void>) {
    setBusy(true);
    setStatusMsg("");
    try {
      await fn();
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectSession(sessionId: string) {
    wsRef.current?.close();
    const ticketInfo = await api(`/v3/agent-sessions/${sessionId}/connect-ticket`, {});
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/v3/agent-sessions/${encodeURIComponent(
      sessionId,
    )}/stream?ticket=${encodeURIComponent(ticketInfo.ticket)}&afterSeq=${lastSeqRef.current}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => setWsState("connected");
    ws.onclose = () => setWsState("detached");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "welcome") {
          setConnectionId(String(msg.connectionId ?? ""));
          setIsWriter(Boolean(msg.isWriter));
          setTruncatedBefore(Number(msg.truncatedBeforeSeq ?? 0));
        } else if (msg.type === "output" && typeof msg.seq === "number") {
          lastSeqRef.current = Math.max(lastSeqRef.current, msg.seq);
          setOutputChunks((prev) =>
            prev.some((c) => c.seq === msg.seq) ? prev : [...prev, msg],
          );
        }
      } catch {
        // Ignore malformed frame
      }
    };
  }

  async function refreshOutputHttp(sessionId: string) {
    const res = await api(
      `/v3/agent-sessions/${sessionId}/output?afterSeq=${lastSeqRef.current}`,
    );
    setTruncatedBefore(Number(res.truncatedBeforeSeq ?? 0));
    if (Array.isArray(res.chunks) && res.chunks.length > 0) {
      const latest = res.chunks[res.chunks.length - 1];
      lastSeqRef.current = Math.max(lastSeqRef.current, Number(latest.seq ?? 0));
      setOutputChunks((prev) => {
        const merged = [...prev];
        for (const chunk of res.chunks) {
          if (!merged.some((x) => x.seq === chunk.seq)) merged.push(chunk);
        }
        return merged;
      });
    }
  }

  return (
    <div className="cli-dock">
      <h4>交互式 CLI 接管与审计</h4>
      <div className="cli-controls">
        <label>
          接管模式
          <select
            value={mode}
            onChange={(e) =>
              setMode(e.target.value as "interactive-read" | "interactive-write")
            }
          >
            <option value="interactive-read">interactive-read（只读排查）</option>
            <option value="interactive-write">interactive-write（可写修复）</option>
          </select>
        </label>
        <label>
          Adapter
          <select
            value={adapter}
            onChange={(e) => setAdapter(e.target.value as "codex" | "opencode")}
          >
            <option value="codex">Codex CLI</option>
            <option value="opencode">OpenCode CLI</option>
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void runAction(async () => {
              const iv = await api(`/v3/runs/${runId}/interventions`, {
                mode,
                expectedRevision: revision,
                ...(nodeId ? { nodeId } : {}),
              });
              setSelectedIv(iv.id);
              await onUpdated();
              setStatusMsg(`已创建干预记录 ${iv.id.slice(0, 8)}（dispatchGate 已暂停自动调度）`);
            })
          }
        >
          创建干预记录
        </button>
      </div>

      {visibleInterventions.length > 0 && (
        <div className="cli-section">
          <label>
            干预记录
            <select
              value={selectedIv}
              onChange={(e) => {
                setSelectedIv(e.target.value);
                setSelectedSession("");
                setOutputChunks([]);
                lastSeqRef.current = 0;
              }}
            >
              {visibleInterventions.map((iv) => (
                <option key={iv.id} value={iv.id}>
                  {iv.id.slice(0, 8)} · {iv.mode} · {iv.reviewState}
                </option>
              ))}
            </select>
          </label>
          {activeIv && (
            <div className="actions">
              {activeIv.reviewState === "pending" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      const sess = await api(`/v3/interventions/${activeIv.id}/sessions`, {
                        adapter,
                      });
                      setSelectedSession(sess.id);
                      await onUpdated();
                      setStatusMsg(`已启动会话 ${sess.id.slice(0, 8)}`);
                    })
                  }
                >
                  启动终端会话
                </button>
              )}
              {activeSess && (
                <>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => void runAction(() => connectSession(activeSess.id))}
                  >
                    {wsState === "connected" ? "重连流" : "连接实时流"}
                  </button>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => void runAction(() => refreshOutputHttp(activeSess.id))}
                  >
                    拉取输出
                  </button>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        wsRef.current?.close();
                        await api(`/v3/agent-sessions/${activeSess.id}/disconnect`, {
                          ...(connectionId ? { connectionId } : {}),
                        });
                        setWsState("detached");
                        await onUpdated();
                        setStatusMsg("已断开浏览器连接，终端进程仍在后台保持。");
                      })
                    }
                  >
                    断开（不断进程）
                  </button>
                  <button
                    className="quiet"
                    disabled={busy || activeSess.processState === "exited"}
                    onClick={() =>
                      void runAction(async () => {
                        await api(`/v3/agent-sessions/${activeSess.id}/stop`, {
                          expectedSessionRevision: activeSess.revision,
                        });
                        await onUpdated();
                        setStatusMsg("已请求停止终端进程。");
                      })
                    }
                  >
                    停止进程
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {activeSess && (
        <div className="cli-terminal">
          <small>
            会话 {activeSess.id.slice(0, 8)} · 进程 {activeSess.processState} · 连接{" "}
            {wsState} ({isWriter ? "主控写入者" : "只读观察者"})
            {truncatedBefore > 0 ? ` · 早于 seq=${truncatedBefore} 的输出已截断` : ""}
          </small>
          <pre className="cli-output">
            {outputChunks.map((c) => c.data).join("") || "(暂无终端输出)"}
          </pre>
          <div className="cli-input-row">
            <input
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={isWriter ? "输入命令并发送（附带换行）" : "当前为只读视图"}
              disabled={!isWriter}
            />
            <button
              disabled={busy || !isWriter || !inputText}
              onClick={() =>
                void runAction(async () => {
                  const data = inputText + "\n";
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: "input", data }));
                  } else if (connectionId) {
                    await api(`/v3/agent-sessions/${activeSess.id}/input`, {
                      connectionId,
                      data,
                    });
                  }
                  setInputText("");
                })
              }
            >
              发送
            </button>
          </div>
        </div>
      )}

      {activeIv?.reviewState === "pending" && (
        <div className="cli-adopt-box">
          <div className="actions">
            <small>
              当前工作区摘要：<code>{wsDigest ?? (activeIv.beforeDigest || "无工作区")}</code>
            </small>
            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const ws = await api(`/v2/adaptive-runs/${runId}/workspace`);
                  setWsDigest(ws.available ? ws.digest : null);
                })
              }
            >
              刷新工作区摘要
            </button>
          </div>
          <label>
            结构化输出映射 (JSON)
            <textarea
              rows={3}
              value={adoptJson}
              onChange={(e) => setAdoptJson(e.target.value)}
            />
          </label>
          <label>
            人工审核依据
            <input
              value={adoptNote}
              onChange={(e) => setAdoptNote(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const parsed = JSON.parse(adoptJson);
                  let expectedDigest = wsDigest;
                  if (expectedDigest === null && activeIv.beforeDigest !== null) {
                    const ws = await api(`/v2/adaptive-runs/${runId}/workspace`);
                    expectedDigest = ws.available ? ws.digest : null;
                    setWsDigest(expectedDigest);
                  }
                  await api(`/v3/interventions/${activeIv.id}/adopt`, {
                    expectedDigest,
                    outputMapping: parsed,
                    note: adoptNote,
                  });
                  await onUpdated();
                  setStatusMsg("已采纳人工干预结果并重新计算下游失效状态。");
                })
              }
            >
              采纳结果 (Adopt)
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  await api(`/v3/interventions/${activeIv.id}/discard`, {
                    note: adoptNote || "放弃本次接管",
                  });
                  await onUpdated();
                  setStatusMsg("已放弃干预记录。");
                })
              }
            >
              放弃 (Discard)
            </button>
          </div>
        </div>
      )}

      {statusMsg && <p role="status" className="canvas-help">{statusMsg}</p>}
    </div>
  );
}
