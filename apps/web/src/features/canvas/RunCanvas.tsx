import { useEffect, useMemo, useRef, useState } from "react";
import type { RunGraph, GraphNode } from "../../../../../packages/graph/projection";
import { defaultPositions, type CanvasLayout, type Point } from "../../../../../packages/graph/layout";

type API = (path: string, data?: unknown) => Promise<any>;
const labels: Record<string, string> = {
  pending: "待执行", running: "执行中", succeeded: "成功", failed: "失败", waiting: "等待处理",
  skipped: "已跳过", uncertain: "待核对", invalidated: "已失效", completed: "已完成",
};
export function RunCanvas({runId, api, onInspect}: {runId: string; api: API; onInspect: (node: GraphNode) => void}) {
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [layout, setLayout] = useState<CanvasLayout>({id: runId, revision: 0, positions: {}});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [zoom, setZoom] = useState(1);
  const [layer, setLayer] = useState("all");
  const [fresh, setFresh] = useState("");
  const drag = useRef<{id: string; start: Point; origin: Point} | null>(null);
  const apiRef = useRef(api); apiRef.current = api;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next: RunGraph = await apiRef.current(`/v3/runs/${runId}/graph`);
        if (active) { setGraph(next); setFresh(new Date().toLocaleTimeString()); setError(""); }
      } catch (e) { if (active) setError("状态刷新失败，当前画布可能已过期：" + String(e)); }
      finally { if (active) timer = setTimeout(poll, 3500); }
    };
    void poll();
    void apiRef.current(`/v3/runs/${runId}/layout`).then((value: CanvasLayout) => {
      if (active) { setLayout(value); setLoaded(true); }
    }).catch((e: unknown) => { if (active) setNotice("布局读取失败，可点击重新载入：" + String(e)); });
    return () => { active = false; clearTimeout(timer); };
  }, [runId]);
  const positions = useMemo(() => {
    if (!graph) return {};
    const defaults = defaultPositions(graph.nodes, graph.edges);
    return Object.fromEntries(graph.nodes.map(n => [n.id, layout.positions[n.id] ?? defaults[n.id]]));
  }, [graph, layout.positions]);
  const node = graph?.nodes.find(n => n.id === selected);
  const edges = graph?.edges.filter(e => layer === "all" || e.kinds.includes(layer as "data" | "observation")) ?? [];
  const width = Math.max(800, ...Object.values(positions).map(p => p.x + 280));
  const height = Math.max(450, ...Object.values(positions).map(p => p.y + 160));
  function move(id: string, p: Point) {
    if (!loaded || saving) return;
    setLayout(before => ({...before, positions: {...before.positions,
      [id]: {x: Math.min(20000, Math.max(0, p.x)), y: Math.min(20000, Math.max(0, p.y))}}}));
    setDirty(true);
  }
  async function save() {
    setSaving(true); setNotice("");
    try {
      const next = await apiRef.current(`/v3/runs/${runId}/layout`, {expectedRevision: layout.revision, positions});
      setLayout(next); setDirty(false); setNotice("布局已保存，执行计划未改变。");
    } catch (e) { setNotice(String(e)); }
    finally { setSaving(false); }
  }
  async function reload() {
    setSaving(true);
    try {
      setLayout(await apiRef.current(`/v3/runs/${runId}/layout`));
      setDirty(false); setLoaded(true); setNotice("已载入服务端布局。");
    } catch (e) { setNotice(String(e)); }
    finally { setSaving(false); }
  }
  return <section className="run-canvas" aria-label="运行画布">
    <div className="canvas-toolbar">
      <strong>运行画布 · 版本 {graph?.revision ?? "…"}</strong>
      <label>关系<select aria-label="显示关系" value={layer} onChange={e => setLayer(e.target.value)}>
        <option value="all">全部依赖</option><option value="data">数据绑定</option><option value="observation">观察点</option>
      </select></label>
      <button className="quiet" aria-label="缩小画布" onClick={() => setZoom(z => Math.max(.4, z - .1))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button className="quiet" aria-label="放大画布" onClick={() => setZoom(z => Math.min(1.6, z + .1))}>＋</button>
      <button className="quiet" disabled={!loaded || saving || !graph} onClick={() => {
        setLayout(l => ({...l, positions: defaultPositions(graph!.nodes, graph!.edges)})); setDirty(true);
      }}>自动布局</button>
      <button disabled={!dirty || saving || !loaded} onClick={() => void save()}>保存布局{dirty ? " *" : ""}</button>
      <button className="quiet" disabled={saving} onClick={() => {
        if (!dirty || window.confirm("重新载入将放弃尚未保存的节点位置，是否继续？")) void reload();
      }}>重新载入布局</button>
    </div>
    <p className="canvas-help">拖动方框调整位置；选中后用方向键微调。滚动查看画布。这里只调整展示，不修改流程或执行状态。{fresh && ` 最近更新 ${fresh}`}</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!graph ? <p>正在读取运行图…</p> : <div className="canvas-workspace">
      <div className="canvas-scroll" tabIndex={0} aria-label="可滚动运行图">
        <div style={{width: width * zoom, height: height * zoom, position: "relative"}}>
          <div className="canvas-surface" style={{width, height, transform: `scale(${zoom})`, transformOrigin: "0 0"}}>
            <svg width={width} height={height} className="canvas-edges" aria-hidden="true">
              <defs><marker id="run-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7890a8"/></marker></defs>
              {edges.map(e => {
                const a = positions[e.source], b = positions[e.target]; if (!a || !b) return null;
                const fromX = a.x + 240, fromY = a.y + 60, toX = b.x, toY = b.y + 60;
                const bend = Math.max(35, Math.abs(toX - fromX) / 2);
                return <path key={e.id} d={`M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`}
                  fill="none" stroke={e.kinds.includes("data") ? "#168a85" : "#7890a8"} strokeWidth="2"
                  strokeDasharray={e.kinds.includes("observation") ? "6 4" : undefined} markerEnd="url(#run-canvas-arrow)"/>;
              })}
            </svg>
            {graph.nodes.map(n => <button key={n.id} type="button" className={`canvas-node ${selected === n.id ? "selected" : ""}`}
              data-state={n.state} style={{left: positions[n.id].x, top: positions[n.id].y}}
              aria-pressed={selected === n.id} aria-label={`${n.title} · ${labels[n.state] ?? n.state}`}
              onClick={() => setSelected(n.id)}
              onKeyDown={e => {
                const steps: Record<string, Point> = {ArrowLeft:{x:-10,y:0},ArrowRight:{x:10,y:0},ArrowUp:{x:0,y:-10},ArrowDown:{x:0,y:10}};
                const step = steps[e.key]; if (step) { e.preventDefault(); move(n.id, {x:positions[n.id].x+step.x,y:positions[n.id].y+step.y}); }
              }}
              onPointerDown={e => {
                if (e.button !== 0 || !loaded || saving) return;
                setSelected(n.id); drag.current = {id:n.id,start:{x:e.clientX,y:e.clientY},origin:positions[n.id]};
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={e => {const d=drag.current;if(d?.id===n.id && (Math.abs(e.clientX-d.start.x)+Math.abs(e.clientY-d.start.y)>3))
                move(n.id,{x:d.origin.x+(e.clientX-d.start.x)/zoom,y:d.origin.y+(e.clientY-d.start.y)/zoom});}}
              onPointerUp={() => {drag.current=null;}} onPointerCancel={() => {drag.current=null;}}>
              <span className="canvas-node-state">{n.kind === "observation" ? "◇ " : ""}{labels[n.state] ?? n.state}</span>
              <strong title={n.title}>{n.title}</strong>
              <small>{n.runner} · {n.cwd === null ? "无工作目录" : n.cwd}</small>
              <small>知识 {n.knowledgeRecorded ? n.knowledge.length : "未记录"} · 工件 {n.artifactCount}</small>
            </button>)}
          </div>
        </div>
      </div>
      <aside className="canvas-inspector" aria-label="节点详情">
        {!node ? <p>点击节点查看执行配置、知识引用和关系。</p> : <>
          <h3>{node.title}</h3><p>{labels[node.state] ?? node.state} · {node.runner}</p>
          <dl><dt>节点 ID</dt><dd>{node.sourceId}</dd><dt>能力版本</dt><dd>{node.capabilityRef ?? "观察点"}</dd>
            <dt>冻结执行配置</dt><dd>{node.profileRef ?? "无"}</dd><dt>工作子目录</dt><dd>{node.cwd ?? "不适用"}</dd>
            <dt>副作用</dt><dd>{node.sideEffect}</dd><dt>Skill</dt><dd>{node.skills.join("、") || "无"}</dd></dl>
          {node.question && <p>{node.question}</p>}{node.decision && <p>{node.decision.decision}：{node.decision.reason}</p>}
          {node.failure && <p role="alert">{node.failure}</p>}
          <h4>实际知识引用</h4>
          {!node.knowledgeRecorded ? <p>尚无本次调用的知识记录；不使用当前知识库推测历史。</p> : node.knowledge.length === 0 ? <p>该调用未记录知识命中。</p> :
            <ul>{node.knowledge.map(k => <li key={k.id}>{k.id}<small className="canvas-digest">{k.digest}</small></li>)}</ul>}
          <h4>相关关系</h4>
          <ul>{graph.edges.filter(e => e.source === node.id || e.target === node.id).map(e => <li key={e.id}>
            {graph.nodes.find(n=>n.id===e.source)?.title} → {graph.nodes.find(n=>n.id===e.target)?.title}
            {e.mappings.map(m => <small key={m.input} className="canvas-digest">{m.output} → {m.input}</small>)}
            {e.condition && <small className="canvas-digest">条件：{e.condition.field} = {JSON.stringify(e.condition.equals)}</small>}
          </li>)}</ul>
          <button onClick={() => onInspect(node)}>查看输出、工件与处理操作</button>
          <p className="canvas-help">交互式 CLI 尚未开放。</p>
        </>}
      </aside>
    </div>}
  </section>;
}
