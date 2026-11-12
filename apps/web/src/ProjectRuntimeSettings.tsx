import type { Project } from "../../../packages/domain/index";
export function ProjectRuntimeSettings({
  project,
  api,
  act,
  onChanged,
}: {
  project: Project;
  api: (path: string, data?: unknown) => Promise<unknown>;
  act: (fn: () => Promise<void>) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  return (
    <details>
      <summary>修改执行授权、测试与初始化命令</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          void act(async () => {
            const command = (name: string) => {
              const executable = String(
                f.get(name + "Executable") ?? "",
              ).trim();
              return executable
                ? {
                    executable,
                    args: JSON.parse(String(f.get(name + "Args") ?? "[]")),
                  }
                : undefined;
            };
            await api("/projects/" + project.id + "/runtime-configuration", {
              allowAgent: f.get("allowAgent") === "on",
              testCommand: command("test") ?? null,
              setupCommand: command("setup") ?? null,
              authorizedCommands: JSON.parse(
                String(f.get("authorizedCommands") ?? "[]"),
              ),
            });
            await onChanged();
          });
        }}
      >
        <label className="checkbox">
          <input
            name="allowAgent"
            type="checkbox"
            defaultChecked={project.allowAgent}
          />
          授权 Agent 与项目程序执行
        </label>
        <label>
          测试程序
          <input
            name="testExecutable"
            defaultValue={project.testCommand?.executable ?? ""}
          />
        </label>
        <label>
          测试参数 JSON
          <input
            name="testArgs"
            defaultValue={JSON.stringify(project.testCommand?.args ?? [])}
          />
        </label>
        <label>
          隔离工作区初始化程序
          <input
            name="setupExecutable"
            defaultValue={project.setupCommand?.executable ?? ""}
          />
        </label>
        <label>
          初始化参数 JSON
          <input
            name="setupArgs"
            defaultValue={JSON.stringify(project.setupCommand?.args ?? [])}
          />
        </label>
        <label>
          额外授权命令 JSON
          <textarea
            name="authorizedCommands"
            defaultValue={JSON.stringify(
              project.authorizedCommands ?? [],
              null,
              2,
            )}
          />
        </label>
        <p>
          命令以本机用户权限直接执行；初始化每个 V2 Worktree
          运行一次。项目存在活跃运行时不能修改配置。
        </p>
        <button>保存项目运行配置</button>
      </form>
    </details>
  );
}
