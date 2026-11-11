import { useEffect, useState, type FormEvent } from "react";
type API = (path: string, data?: unknown) => Promise<any>;
type Resource = {
  id: string;
  kind: string;
  name: string;
  version: string;
  content: string;
  status: string;
  contentDigest: string;
};
export function ResourceManager({
  api,
  act,
  refresh,
}: {
  api: API;
  act: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [resources, setResources] = useState<Resource[]>([]),
    [sources, setSources] = useState<{ id: string; path: string; lastScannedAt: string | null }[]>([]),
    [external, setExternal] = useState<{ id: string; sourceId: string; relativePath: string; name: string; description: string; status: string; contentDigest: string }[]>([]),
    [scanNotice, setScanNotice] = useState(""),
    [plan, setPlan] = useState("[]");
  const load = async () => {
    const [versions, roots, imported] = await Promise.all([
      api("/resources"), api("/skill-sources"), api("/external-skills"),
    ]);
    setResources(versions);
    setSources(roots);
    setExternal(imported);
  };
  useEffect(() => {
    void act(async () => {
      await load();
      setPlan(JSON.stringify(await api("/capabilities"), null, 2));
    });
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form),
      kind = data.get("kind");
    void act(async () => {
      await api("/resources", {
        kind,
        name: data.get("name"),
        version: data.get("version"),
        content: data.get("content"),
        sources: String(data.get("sources"))
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        taskType: data.get("taskType"),
        ...(kind === "workflow"
          ? { nodes: JSON.parse(String(data.get("nodes"))) }
          : {}),
      });
      form.reset();
      await load();
    });
  }
  return (
    <>
      <div className="panel">
        <h2>外部 Skill 目录（仅引用）</h2>
        <p>输入本机绝对文件夹路径，扫描其中的 SKILL.md。这里只记录目录和元数据，不复制 Skill 文件。执行准备时读取最新内容并固定该次运行的指令快照。</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const path = String(new FormData(form).get("path") ?? "").trim();
          void act(async () => {
            const result = await api("/skill-sources", { path });
            setScanNotice("发现 " + result.found + " 个 Skill；" + result.missing + " 个原引用已失效。" + (result.warnings.length ? " 注意：" + result.warnings.slice(0, 5).join("；") : ""));
            form.reset();
            await load();
            await refresh();
          });
        }}>
          <label>Skill 来源目录绝对路径
            <input name="path" placeholder="例如 C:\\Users\\me\\.agents\\skills" required />
          </label>
          <button>注册并扫描</button>
        </form>
        {scanNotice && <p role="status">{scanNotice}</p>}
        {sources.map((source) => (
          <article className="project" key={source.id}>
            <p><code>{source.path}</code></p>
            <small>上次扫描：{source.lastScannedAt ?? "尚未扫描"}</small>
            <div className="actions"><button className="quiet" onClick={() => void act(async () => {
              const result = await api(`/skill-sources/${source.id}/scan`, {});
              setScanNotice("发现 " + result.found + " 个 Skill；" + result.missing + " 个引用失效。" + (result.warnings.length ? " 注意：" + result.warnings.slice(0, 5).join("；") : ""));
              await load();
              await refresh();
            })}>重新扫描</button></div>
            {external.filter((item) => item.sourceId === source.id).map((skill) => (
              <div key={skill.id}>
                <b>{skill.name}</b> · {skill.status} · {skill.relativePath || "."}
                <p>{skill.description}</p>
                <small>SHA256: {skill.contentDigest}</small>
              </div>
            ))}
          </article>
        ))}
        <p>含 scripts、references 等辅助文件的 Skill 仍保存在原目录；当前只保证 SKILL.md 指令加载，辅助文件访问取决于执行器沙箱和文件权限。</p>
      </div>
      <div className="panel">
        <h2>创建资源版本</h2>
        <p>
          先创建候选，再人工发布。每个版本不可覆盖；知识必须填写来源，工作流必须保留测试、审查与交付。
        </p>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>
              类型
              <select name="kind">
                <option value="skill">Skill</option>
                <option value="knowledge">知识</option>
                <option value="workflow">工作流</option>
              </select>
            </label>
            <label>
              版本
              <input
                name="version"
                defaultValue="1.0.0"
                required
                pattern="[0-9]+\.[0-9]+\.[0-9]+"
              />
            </label>
          </div>
          <label>
            名称
            <input name="name" required />
          </label>
          <label>
            工作流任务类型（仅工作流使用）
            <select name="taskType">
              <option value="development">需求开发</option>
              <option value="diagnosis">故障诊断</option>
            </select>
          </label>
          <label>
            内容
            <textarea name="content" required />
          </label>
          <label>
            来源（每行一项）
            <textarea
              name="sources"
              placeholder="知识必须填写原始证据或文档位置"
            />
          </label>
          <details>
            <summary>工作流节点（JSON；仅工作流类型使用）</summary>
            <textarea name="nodes" defaultValue={plan} key={plan} rows={14} />
          </details>
          <button>保存候选版本</button>
        </form>
      </div>
      <div className="panel">
        <h2>版本列表</h2>
        {resources.length === 0 && <p>暂无资源。发布后可在创建任务时选择。</p>}
        {resources.map((r) => (
          <article className="project" key={r.id}>
            <h3>
              {r.name} @{r.version}{" "}
              <span className="badge">
                {r.kind} · {r.status}
              </span>
            </h3>
            <pre>{r.content}</pre>
            <small>SHA256: {r.contentDigest}</small>
            <div className="actions">
              {r.status !== "revoked" && (
                <>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await api(`/resources/${r.id}/publish`, {});
                        await load();
                      })
                    }
                  >
                    发布此版本
                  </button>
                  <button
                    className="quiet danger"
                    onClick={() =>
                      void act(async () => {
                        await api(`/resources/${r.id}/revoke`, {});
                        await load();
                      })
                    }
                  >
                    撤销版本
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
