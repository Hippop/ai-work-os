import { useState, useEffect } from "react";
export function RuntimeStatus({
  api,
  act,
}: {
  api: (path: string, data?: unknown) => Promise<any>;
  act: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [runtimes, setRuntimes] = useState<any[]>([]);
  useEffect(() => {
    void act(async () => setRuntimes(await api("/runtimes")));
  }, []);
  return (
    <div className="panel">
      <h2>执行器状态</h2>
      {runtimes.map((runtime) => (
        <article key={runtime.id}>
          <h3>
            {runtime.id} · {runtime.available ? "已检测到" : "不可用"}
          </h3>
          <p>
            版本：{runtime.version ?? "未知"} · 配置模型：
            {runtime.model ?? "执行器默认"} · 推理设置：
            {runtime.reasoning ?? "默认"}
          </p>
          <small>配置摘要：{runtime.configurationDigest ?? "未记录"}</small>
        </article>
      ))}
      <p>
        启动时记录根配置摘要与显式模型参数；检测到根配置变化时拒绝继续执行。这里只显示配置模型标识，不承诺服务端权重版本固定。
      </p>
      <button
        className="quiet"
        onClick={() =>
          void act(async () => setRuntimes(await api("/runtimes/probe", {})))
        }
      >
        重新检测执行器与配置
      </button>
    </div>
  );
}
