import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../../../../../packages/domain/index";
import type { GraphNode, RunGraph } from "../../../../../packages/graph/projection";
import { mergeRunEvents } from "../../../../../packages/graph/events-merge";
import {
  defaultPositions,
  type CanvasLayout,
  type Point,
} from "../../../../../packages/graph/layout";
import type { NodeContextLookup } from "../../../../../packages/context/assembler";
import { CliSessionDock } from "./CliSessionDock";
import { ChangeProposalPanel, DesignModePanel } from "./DesignModePanel";

type API = (
  path: string,
  data?: unknown,
  headers?: Record<string, string>,
  method?: string,
) => Promise<any>;

type WorkbenchMode = "run" | "design" | "history";
type InspectorTab = "overview" | "context" | "cli" | "outputs" | "events";

const labels: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  waiting: "等待处理",
  skipped: "已跳过",
  uncertain: "待核对",
  invalidated: "已失效",
  completed: "已完成",
};

const validityLabels: Record<string, string> = {
  valid: "有效",
  stale: "待重算(stale)",
  invalid: "已失效(invalid)",
  invalidated: "已失效",
  "uncertain-effect": "写效果待核对",
  unknown: "未知",
};

export function RunCanvas({
  runId,
  api,
  onInspect,
  tasks = [],
  capabilities = [],
  profiles = [],
  onRunStarted,
  onResolveGap,
  onChanged,
  initialMode,
}: {
  runId: string;
  api: API;
  onInspect: (node: GraphNode) => void;
  tasks?: Task[];
  capabilities?: { id: string; name: string; version: string; status: string }[];
  profiles?: { id: string; name: string; version: string; status: string }[];
  onRunStarted?: (runId: string) => void;
  onResolveGap?: (gapTitle: string) => void;
  onChanged?: () => Promise<void>;
  initialMode?: WorkbenchMode;
}) {
  const [mode, setMode] = useState<WorkbenchMode>(
    initialMode ?? (runId ? "run" : "design"),
  );
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [viewRevision, setViewRevision] = useState<number | undefined>(undefined);
  const [layout, setLayout] = useState<CanvasLayout>({
    id: runId || "draft",
    revision: 0,
    positions: {},
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [zoom, setZoom] = useState(1);
  const [layer, setLayer] = useState("all");
  const [fresh, setFresh] = useState("");
  const [runEvents, setRunEvents] = useState<any[]>([]);
  const [contextData, setContextData] = useState<NodeContextLookup | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeContent, setKnowledgeContent] = useState("");

  const drag = useRef<{ id: string; start: Point; origin: Point } | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (runId && mode === "design" && !initialMode) {
      setMode("run");
    }
  }, [runId]);

  const fetchSnapshot = async (rev?: number) => {
    if (!runId) return;
    const qs = rev !== undefined ? `?revision=${rev}` : "";
    const next: RunGraph = await apiRef.current(`/v3/runs/${runId}/graph${qs}`);
    setGraph(next);
    if (rev === undefined && typeof next.lastSeq === "number") {
      lastSeqRef.current = Math.max(lastSeqRef.current, next.lastSeq);
    }
    setFresh(new Date().toLocaleTimeString());
    setError("");
  };

  useEffect(() => {
    if (!runId) {
      setGraph(null);
      setRunEvents([]);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    lastSeqRef.current = 0;
    setRunEvents([]);

    const sync = async () => {
      try {
        if (viewRevision !== undefined) {
          await fetchSnapshot(viewRevision);
        } else if (lastSeqRef.current === 0) {
          await fetchSnapshot();
          const page = await apiRef.current(`/v3/runs/${runId}/events?after=0&limit=200`);
          if (!active) return;
          const merged = mergeRunEvents([], page.events ?? [], 0);
          setRunEvents(merged.events);
          lastSeqRef.current = merged.lastSeq;
        } else {
          const expectedAfter = lastSeqRef.current;
          const page = await apiRef.current(
            `/v3/runs/${runId}/events?after=${expectedAfter}&limit=200`,
          );
          if (!active) return;
          if (page.snapshotRequired) {
            await fetchSnapshot();
          } else {
            const incoming = page.events ?? [];
            let needSnapshot = false;
            setRunEvents((prev) => {
              const merged = mergeRunEvents(prev, incoming, expectedAfter);
              needSnapshot = merged.snapshotRequired;
              lastSeqRef.current = merged.lastSeq;
              return merged.events;
            });
            if (needSnapshot || incoming.length > 0) {
              await fetchSnapshot();
            }
          }
          setFresh(new Date().toLocaleTimeString());
          setError("");
        }
      } catch (e) {
        if (active) setError("状态刷新失败，当前画布可能已过期：" + String(e));
      } finally {
        if (active) timer = setTimeout(sync, 3500);
      }
    };

    void sync();
    void apiRef
      .current(`/v3/runs/${runId}/layout`)
      .then((value: CanvasLayout) => {
        if (active) {
          setLayout(value);
          if (value.viewport?.zoom) setZoom(value.viewport.zoom);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (active) setNotice("布局读取失败，可点击重新载入：" + String(e));
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId, viewRevision]);

  const positions = useMemo(() => {
    if (!graph) return {};
    const defaults = defaultPositions(graph.nodes, graph.edges);
    return Object.fromEntries(
      graph.nodes.map((n) => [n.id, layout.positions[n.id] ?? defaults[n.id]]),
    );
  }, [graph, layout.positions]);

  const node = graph?.nodes.find((n) => n.id === selected);

  useEffect(() => {
    if (!runId || !node || node.kind !== "capability") {
      setContextData(null);
      return;
    }
    if (inspectorTab !== "context") return;
    let cancelled = false;
    setContextLoading(true);
    const invQs = node.invocationId
      ? `?invocationId=${encodeURIComponent(node.invocationId)}`
      : "";
    void apiRef
      .current(
        `/v3/runs/${runId}/nodes/${encodeURIComponent(node.sourceId)}/context${invQs}`,
      )
      .then((res: NodeContextLookup) => {
        if (!cancelled) setContextData(res);
      })
      .catch(() => {
        if (!cancelled) setContextData(null);
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, node?.sourceId, node?.invocationId, inspectorTab]);

  const visibleNodes = useMemo(() => {
    if (!graph) return [];
    if (layer === "affected") {
      const affected = graph.nodes.filter(
        (n) =>
          (n.validity && n.validity !== "valid") ||
          ["failed", "uncertain", "waiting", "invalidated"].includes(n.state) ||
          Boolean(n.activeInterventionId),
      );
      return affected.length ? affected : graph.nodes;
    }
    return graph.nodes;
  }, [graph, layer]);

  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const edges =
    graph?.edges.filter((e) => {
      if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target)) {
        return false;
      }
      if (layer === "all" || layer === "affected" || layer === "knowledge") return true;
      return e.kinds.includes(layer as "data" | "observation");
    }) ?? [];

  const width = Math.max(800, ...Object.values(positions).map((p) => p.x + 280));
  const height = Math.max(450, ...Object.values(positions).map((p) => p.y + 160));

  function move(id: string, p: Point) {
    if (!loaded || saving) return;
    setLayout((before) => ({
      ...before,
      positions: {
        ...before.positions,
        [id]: {
          x: Math.min(20000, Math.max(0, p.x)),
          y: Math.min(20000, Math.max(0, p.y)),
        },
      },
    }));
    setDirty(true);
  }

  async function save() {
    if (!runId) return;
    setSaving(true);
    setNotice("");
    try {
      const next = await apiRef.current(
        `/v3/canvas-layouts/${runId}`,
        {
          expectedRevision: layout.revision,
          graphId: runId,
          positions,
          viewport: { x: 0, y: 0, zoom },
        },
        {},
        "PATCH",
      );
      setLayout(next);
      setDirty(false);
      setNotice("布局已保存，执行计划未改变。");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    if (!runId) return;
    setSaving(true);
    try {
      const next = await apiRef.current(`/v3/runs/${runId}/layout`);
      setLayout(next);
      if (next.viewport?.zoom) setZoom(next.viewport.zoom);
      setDirty(false);
      setLoaded(true);
      setNotice("已载入服务端布局。");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="run-canvas" aria-label="运行画布">
      <div className="canvas-mode-bar">
        <button
          className={mode === "run" ? "" : "quiet"}
          disabled={!runId}
          onClick={() => setMode("run")}
        >
          运行监控 (Run)
        </button>
        <button
          className={mode === "design" ? "" : "quiet"}
          onClick={() => setMode("design")}
        >
          方案设计 (PlanDraft)
        </button>
        <button
          className={mode === "history" ? "" : "quiet"}
          disabled={!runId}
          onClick={() => setMode("history")}
        >
          版本回溯与变更 (History & Proposals)
        </button>
        {graph?.dispatchGate && (
          <span className="canvas-badge">
            Gate: {graph.dispatchGate.state}
          </span>
        )}
        {graph?.historicalView && (
          <span className="canvas-badge warn">只读历史视图</span>
        )}
      </div>

      {mode === "design" && (
        <DesignModePanel
          api={api}
          tasks={tasks}
          capabilities={capabilities}
          profiles={profiles}
          onRunStarted={(newRunId) => {
            onRunStarted?.(newRunId);
            setViewRevision(undefined);
            setMode("run");
            void onChanged?.();
          }}
          onResolveGap={onResolveGap}
        />
      )}

      {mode === "history" && runId && graph && (
        <div className="history-workbench">
          <div className="canvas-toolbar">
            <label>
              查看计划版本
              <select
                value={viewRevision ?? ""}
                onChange={(e) =>
                  setViewRevision(e.target.value ? Number(e.target.value) : undefined)
                }
              >
                <option value="">当前最新 (revision {graph.revision})</option>
                {(graph.revisions ?? []).map((r) => (
                  <option key={r.revision} value={r.revision}>
                    Revision {r.revision} · {r.rationale.slice(0, 32) || "计划版本"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ChangeProposalPanel
            runId={runId}
            revision={graph.revision}
            api={api}
            onCommitted={async () => {
              setViewRevision(undefined);
              await fetchSnapshot();
              await onChanged?.();
            }}
          />
        </div>
      )}

      {mode !== "design" && (
        <>
          <div className="canvas-toolbar">
            <strong>
              运行画布 · 版本 {graph?.revision ?? "…"}
              {graph?.allowedActions?.length
                ? ` · 可用操作: ${graph.allowedActions.join(", ")}`
                : ""}
            </strong>
            <label>
              关系
              <select
                aria-label="显示关系"
                value={layer}
                onChange={(e) => setLayer(e.target.value)}
              >
                <option value="all">全部依赖</option>
                <option value="data">数据绑定</option>
                <option value="observation">观察点</option>
                <option value="knowledge">知识视图</option>
                <option value="affected">仅看受影响节点</option>
              </select>
            </label>
            <button
              className="quiet"
              aria-label="缩小画布"
              onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              className="quiet"
              aria-label="放大画布"
              onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}
            >
              ＋
            </button>
            <button
              className="quiet"
              disabled={!loaded || saving || !graph}
              onClick={() => {
                setLayout((l) => ({
                  ...l,
                  positions: defaultPositions(graph!.nodes, graph!.edges),
                }));
                setDirty(true);
              }}
            >
              自动布局
            </button>
            <button disabled={!dirty || saving || !loaded} onClick={() => void save()}>
              保存布局{dirty ? " *" : ""}
            </button>
            <button
              className="quiet"
              disabled={saving}
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm("重新载入将放弃尚未保存的节点位置，是否继续？")
                ) {
                  void reload();
                }
              }}
            >
              重新载入布局
            </button>
          </div>
          <p className="canvas-help">
            拖动方框调整位置；选中后用方向键微调。布局调整不修改执行计划或事件流。
            {fresh && ` 最近更新 ${fresh}`}
          </p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {!graph ? (
            <p>{runId ? "正在读取运行图…" : "请先选择运行或切换到方案设计创建工作流。"}</p>
          ) : (
            <div className="canvas-workspace">
              <div className="canvas-scroll" tabIndex={0} aria-label="可滚动运行图">
                <div
                  style={{
                    width: width * zoom,
                    height: height * zoom,
                    position: "relative",
                  }}
                >
                  <div
                    className="canvas-surface"
                    style={{
                      width,
                      height,
                      transform: `scale(${zoom})`,
                      transformOrigin: "0 0",
                    }}
                  >
                    <svg
                      width={width}
                      height={height}
                      className="canvas-edges"
                      aria-hidden="true"
                    >
                      <defs>
                        <marker
                          id="run-canvas-arrow"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="7"
                          markerHeight="7"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#7890a8" />
                        </marker>
                      </defs>
                      {edges.map((e) => {
                        const a = positions[e.source],
                          b = positions[e.target];
                        if (!a || !b) return null;
                        const fromX = a.x + 240,
                          fromY = a.y + 60,
                          toX = b.x,
                          toY = b.y + 60;
                        const bend = Math.max(35, Math.abs(toX - fromX) / 2);
                        return (
                          <path
                            key={e.id}
                            d={`M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${
                              toX - bend
                            } ${toY}, ${toX} ${toY}`}
                            fill="none"
                            stroke={e.kinds.includes("data") ? "#168a85" : "#7890a8"}
                            strokeWidth="2"
                            strokeDasharray={
                              e.kinds.includes("observation") ? "6 4" : undefined
                            }
                            markerEnd="url(#run-canvas-arrow)"
                          />
                        );
                      })}
                    </svg>
                    {visibleNodes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className={`canvas-node ${selected === n.id ? "selected" : ""}`}
                        data-state={n.state}
                        data-validity={n.validity ?? "valid"}
                        style={{ left: positions[n.id].x, top: positions[n.id].y }}
                        aria-pressed={selected === n.id}
                        aria-label={`${n.title} · ${labels[n.state] ?? n.state}`}
                        onClick={() => setSelected(n.id)}
                        onKeyDown={(e) => {
                          const steps: Record<string, Point> = {
                            ArrowLeft: { x: -10, y: 0 },
                            ArrowRight: { x: 10, y: 0 },
                            ArrowUp: { x: 0, y: -10 },
                            ArrowDown: { x: 0, y: 10 },
                          };
                          const step = steps[e.key];
                          if (step) {
                            e.preventDefault();
                            move(n.id, {
                              x: positions[n.id].x + step.x,
                              y: positions[n.id].y + step.y,
                            });
                          }
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || !loaded || saving) return;
                          setSelected(n.id);
                          drag.current = {
                            id: n.id,
                            start: { x: e.clientX, y: e.clientY },
                            origin: positions[n.id],
                          };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const d = drag.current;
                          if (
                            d?.id === n.id &&
                            Math.abs(e.clientX - d.start.x) +
                              Math.abs(e.clientY - d.start.y) >
                              3
                          ) {
                            move(n.id, {
                              x: d.origin.x + (e.clientX - d.start.x) / zoom,
                              y: d.origin.y + (e.clientY - d.start.y) / zoom,
                            });
                          }
                        }}
                        onPointerUp={() => {
                          drag.current = null;
                        }}
                        onPointerCancel={() => {
                          drag.current = null;
                        }}
                      >
                        <span className="canvas-node-state">
                          {n.kind === "observation" ? "◇ " : ""}
                          {labels[n.state] ?? n.state}
                          {n.validity && n.validity !== "valid"
                            ? ` · ${validityLabels[n.validity] ?? n.validity}`
                            : ""}
                          {n.effectState ? ` · ${n.effectState}` : ""}
                        </span>
                        <strong title={n.title}>{n.title}</strong>
                        <small>
                          {n.runner} · {n.cwd === null ? "无工作目录" : n.cwd}
                        </small>
                        <small>
                          知识 {n.knowledgeRecorded ? n.knowledge.length : "未记录"} ·
                          工件 {n.artifactCount}
                          {n.activeInterventionId ? " · 人工接管中" : ""}
                        </small>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <aside className="canvas-inspector" aria-label="节点详情">
                {!node ? (
                  <p>点击节点查看执行配置、输入知识清单、CLI 接管和历史事件。</p>
                ) : (
                  <>
                    <h3>{node.title}</h3>
                    <p>
                      {labels[node.state] ?? node.state} · {node.runner}
                      {node.validity
                        ? ` · ${validityLabels[node.validity] ?? node.validity}`
                        : ""}
                    </p>
                    <div className="inspector-tabs" role="tablist">
                      {(
                        [
                          ["overview", "概览"],
                          ["context", "输入与知识"],
                          ["cli", "执行与 CLI"],
                          ["outputs", "输出与证据"],
                          ["events", "历史"],
                        ] as const
                      ).map(([tabKey, label]) => (
                        <button
                          key={tabKey}
                          role="tab"
                          aria-selected={inspectorTab === tabKey}
                          className={inspectorTab === tabKey ? "" : "quiet"}
                          onClick={() => setInspectorTab(tabKey)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {inspectorTab === "overview" && (
                      <>
                        <dl>
                          <dt>节点 ID / 稳定 ID</dt>
                          <dd>
                            {node.sourceId}
                            {node.stableNodeId ? ` (${node.stableNodeId})` : ""}
                          </dd>
                          <dt>能力版本</dt>
                          <dd>{node.capabilityRef ?? "观察点"}</dd>
                          <dt>冻结执行配置</dt>
                          <dd>{node.profileRef ?? "无"}</dd>
                          <dt>工作子目录</dt>
                          <dd>{node.cwd ?? "不适用"}</dd>
                          <dt>副作用与效应台账</dt>
                          <dd>
                            {node.sideEffect}
                            {node.effectState ? ` (${node.effectState})` : ""}
                          </dd>
                          <dt>Skill</dt>
                          <dd>{node.skills.join("、") || "无"}</dd>
                        </dl>
                        {node.question && <p>{node.question}</p>}
                        {node.decision && (
                          <p>
                            {node.decision.decision}：{node.decision.reason}
                          </p>
                        )}
                        {node.failure && <p role="alert">{node.failure}</p>}
                        <h4>实际知识引用</h4>
                        {!node.knowledgeRecorded ? (
                          <p>尚无本次调用的知识记录；不使用当前知识库推测历史。</p>
                        ) : node.knowledge.length === 0 ? (
                          <p>该调用未记录知识命中。</p>
                        ) : (
                          <ul>
                            {node.knowledge.map((k) => (
                              <li key={k.id}>
                                {k.id}
                                <small className="canvas-digest">{k.digest}</small>
                              </li>
                            ))}
                          </ul>
                        )}
                        <h4>相关关系</h4>
                        <ul>
                          {graph.edges
                            .filter((e) => e.source === node.id || e.target === node.id)
                            .map((e) => (
                              <li key={e.id}>
                                {graph.nodes.find((n) => n.id === e.source)?.title} →{" "}
                                {graph.nodes.find((n) => n.id === e.target)?.title}
                                {e.mappings.map((m) => (
                                  <small key={m.input} className="canvas-digest">
                                    {m.output} → {m.input}
                                  </small>
                                ))}
                                {e.condition && (
                                  <small className="canvas-digest">
                                    条件：{e.condition.field} ={" "}
                                    {JSON.stringify(e.condition.equals)}
                                  </small>
                                )}
                              </li>
                            ))}
                        </ul>
                        <button onClick={() => onInspect(node)}>
                          查看输出、工件与处理操作
                        </button>
                      </>
                    )}

                    {inspectorTab === "context" && (
                      <div>
                        <h4>上下文装配清单 (ContextManifest)</h4>
                        {contextLoading ? (
                          <p>正在加载上下文清单…</p>
                        ) : !contextData ? (
                          <p>请选择能力节点以查看输入与知识契约装配结果。</p>
                        ) : !contextData.available ? (
                          <p role="note">
                            该调用属于旧版上下文模式（{contextData.contextMode}）：
                            {contextData.reason}，不会伪造输入清单。
                          </p>
                        ) : (
                          <>
                            <p>
                              字符预算：{contextData.manifest.totalChars} /{" "}
                              {contextData.manifest.budgetChars} · 模式{" "}
                              {contextData.contextMode}
                            </p>
                            <h5>已解析输入</h5>
                            <pre>
                              {JSON.stringify(
                                contextData.manifest.resolvedInputs,
                                null,
                                2,
                              )}
                            </pre>
                            <h5>数据绑定来源</h5>
                            <ul>
                              {contextData.manifest.bindingSources.map((b, i) => (
                                <li key={i}>
                                  {b.fromNode} ({b.pointer}) → {b.target}
                                  <small className="canvas-digest">{b.digest}</small>
                                </li>
                              ))}
                            </ul>
                            <h5>知识命中与省略</h5>
                            <ul>
                              {contextData.manifest.knowledgeHits.map((k) => (
                                <li key={k.id}>
                                  {k.id}@{k.version} · {k.reason}
                                </li>
                              ))}
                              {contextData.manifest.omissions.map((o, i) => (
                                <li key={`omit-${i}`}>
                                  [已省略] {o.kind}:{o.id} — {o.reason}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}

                    {inspectorTab === "cli" && (
                      <CliSessionDock
                        runId={runId}
                        revision={graph.revision}
                        nodeId={node.kind === "capability" ? node.sourceId : undefined}
                        api={api}
                        interventions={graph.interventions ?? []}
                        sessions={graph.sessions ?? []}
                        onUpdated={async () => {
                          await fetchSnapshot();
                          await onChanged?.();
                        }}
                      />
                    )}

                    {inspectorTab === "outputs" && (
                      <div>
                        <h4>节点输出工件 ({node.artifactCount})</h4>
                        <ul>
                          {(graph.artifactCards ?? [])
                            .filter((a) => a.nodeId === node.sourceId)
                            .map((a) => (
                              <li key={a.id}>
                                {a.name}
                                <small className="canvas-digest">
                                  {a.digest ?? a.path}
                                </small>
                              </li>
                            ))}
                        </ul>
                        <button className="quiet" onClick={() => onInspect(node)}>
                          定位到完整详情面板
                        </button>
                        <hr />
                        <h5>沉淀为项目知识候选（仅限 project 作用域）</h5>
                        <input
                          value={knowledgeTitle}
                          onChange={(e) => setKnowledgeTitle(e.target.value)}
                          placeholder="知识标题"
                        />
                        <textarea
                          rows={3}
                          value={knowledgeContent}
                          onChange={(e) => setKnowledgeContent(e.target.value)}
                          placeholder="填写基于运行证据的知识内容…"
                        />
                        <button
                          disabled={!knowledgeTitle.trim() || !knowledgeContent.trim()}
                          onClick={async () => {
                            try {
                              await api("/v3/knowledge-candidates", {
                                runId,
                                ...(node.invocationId ? { invocationId: node.invocationId } : {}),
                                nodeId: node.sourceId,
                                name: `claim.${node.sourceId}.${Date.now().toString(36)}`,
                                version: "1.0.0",
                                title: knowledgeTitle.trim(),
                                content: knowledgeContent.trim(),
                                scope: "project",
                                applicableConditions: [
                                  `task:${graph.taskId}`,
                                  `node:${node.sourceId}`,
                                ],
                                artifactRefs: (graph.artifactCards ?? [])
                                  .filter((a) => a.nodeId === node.sourceId)
                                  .map((a) => a.path),
                              });
                              setKnowledgeTitle("");
                              setKnowledgeContent("");
                              setNotice("已提交待审核知识候选（需人工发布后才可生效）。");
                            } catch (e) {
                              setNotice(String(e));
                            }
                          }}
                        >
                          提交知识候选
                        </button>
                      </div>
                    )}

                    {inspectorTab === "events" && (
                      <div>
                        <h4>相关运行事件 ({runEvents.length})</h4>
                        <ul>
                          {runEvents
                            .filter((ev) => {
                              const p = JSON.stringify(ev.payload ?? {});
                              return (
                                p.includes(node.sourceId) ||
                                (node.invocationId && p.includes(node.invocationId)) ||
                                ev.type.startsWith("change.") ||
                                ev.type.startsWith("intervention.") ||
                                ev.type.startsWith("adaptive.plan.")
                              );
                            })
                            .slice(-40)
                            .reverse()
                            .map((ev) => (
                              <li key={ev.id}>
                                <b>
                                  #{ev.seq} {ev.type}
                                </b>{" "}
                                <small>
                                  {ev.planRevision ? `rev=${ev.planRevision} · ` : ""}
                                  {ev.at}
                                </small>
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </section>
  );
}
