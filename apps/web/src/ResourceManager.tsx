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
}: {
  api: API;
  act: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [resources, setResources] = useState<Resource[]>([]),
    [plan, setPlan] = useState("[]");
  const load = async () => {
    setResources(await api("/resources"));
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
