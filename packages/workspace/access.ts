import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DomainError } from "../domain/index.js";
import type {
  WorkspaceAccess,
  WorkspaceHolder,
} from "../graph/types.js";
import type { Store } from "../persistence/index.js";

export type AccessMode = WorkspaceHolder["mode"];

export function canonicalWorkspaceId(workspacePath: string): string {
  try {
    return realpathSync(workspacePath);
  } catch {
    throw new DomainError(
      "workspace_missing",
      `工作区目录不存在: ${workspacePath}`,
      422,
    );
  }
}

export function resolveAuthorizedSubdir(
  workspaceRoot: string,
  subdir = ".",
  authorizedRoot?: string,
): { workspaceId: string; cwd: string } {
  const root = canonicalWorkspaceId(workspaceRoot);
  if (authorizedRoot) {
    const authRoot = canonicalWorkspaceId(authorizedRoot);
    const relAuth = relative(authRoot, root);
    if (relAuth === ".." || relAuth.startsWith(".." + sep) || isAbsolute(relAuth)) {
      throw new DomainError(
        "workspace_escape",
        "工作区不在授权仓库根目录内",
        403,
      );
    }
  }
  if (
    subdir !== "." &&
    (isAbsolute(subdir) ||
      subdir.startsWith("/") ||
      subdir.includes("\\") ||
      subdir
        .split("/")
        .some((part) => !part || part === "." || part === ".."))
  ) {
    throw new DomainError(
      "working_dir_escape",
      "工作子目录包含非法路径段",
      403,
    );
  }
  let cursor = root;
  if (subdir !== ".") {
    for (const part of subdir.split("/")) {
      cursor = join(cursor, part);
      let stat;
      try {
        stat = lstatSync(cursor);
      } catch {
        throw new DomainError(
          "working_dir_missing",
          "指定的工作目录不存在",
          422,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new DomainError(
          "working_dir_escape",
          "工作子目录不允许包含符号链接",
          403,
        );
      }
    }
  }
  let cwd: string;
  try {
    cwd = realpathSync(cursor);
  } catch {
    throw new DomainError("working_dir_missing", "指定的工作目录不存在", 422);
  }
  const rel = relative(root, cwd);
  if (
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel) ||
    !statSync(cwd).isDirectory()
  ) {
    throw new DomainError("working_dir_escape", "工作目录越过授权根目录", 403);
  }
  return { workspaceId: root, cwd };
}

export class WorkspaceAccessCoordinator {
  constructor(private store: Store) {}

  get(workspacePath: string): WorkspaceAccess | undefined {
    const workspaceId = canonicalWorkspaceId(workspacePath);
    return this.store.get<WorkspaceAccess>("workspace_access", workspaceId);
  }

  acquire(params: {
    workspacePath: string;
    authorizedRoot?: string;
    owner: string;
    mode: AccessMode;
    processIdentity?: WorkspaceAccess["processIdentity"];
  }): { workspaceId: string; epoch: number; access: WorkspaceAccess } {
    const { workspaceId } = resolveAuthorizedSubdir(
      params.workspacePath,
      ".",
      params.authorizedRoot,
    );
    return this.store.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.store.get<WorkspaceAccess>(
        "workspace_access",
        workspaceId,
      );
      if (existing?.status === "needs-reconciliation") {
        throw new DomainError(
          "workspace_reconciliation_required",
          "工作区访问锁尚待人工核对，不能授予新访问权",
          409,
        );
      }
      const holders = existing?.status === "active" ? [...existing.holders] : [];
      if (holders.length > 0) {
        if (params.mode === "read-only") {
          if (holders.some((h) => h.mode !== "read-only")) {
            throw new DomainError(
              "workspace_write_locked",
              "工作区正被写入者或人工会话独占，不允许并发只读访问",
              409,
            );
          }
        } else {
          throw new DomainError(
            "workspace_locked",
            "工作区正被其他读取或写入持有者占用，写入必须独占",
            409,
          );
        }
      }
      const epoch = (existing?.epoch ?? 0) + 1;
      const nextHolders: WorkspaceHolder[] = [
        ...holders,
        { owner: params.owner, mode: params.mode, epoch, acquiredAt: now },
      ];
      const access: WorkspaceAccess = {
        id: workspaceId,
        workspaceId,
        owner: params.owner,
        mode: params.mode,
        epoch,
        status: "active",
        holders: nextHolders,
        ...(params.processIdentity
          ? { processIdentity: params.processIdentity }
          : {}),
        acquiredAt: now,
        updatedAt: now,
      };
      this.store.put("workspace_access", access);
      return { workspaceId, epoch, access };
    });
  }

  assertEpoch(workspacePath: string, owner: string, epoch: number): void {
    const workspaceId = canonicalWorkspaceId(workspacePath);
    const current = this.store.get<WorkspaceAccess>(
      "workspace_access",
      workspaceId,
    );
    if (!current || current.status !== "active") {
      throw new DomainError(
        "stale_workspace_epoch",
        "工作区访问锁未激活或已失效，拒绝旧 epoch 提交结果",
        409,
      );
    }
    const matched = current.holders.find(
      (h) => h.owner === owner && h.epoch === epoch,
    );
    if (!matched) {
      throw new DomainError(
        "stale_workspace_epoch",
        "工作区访问 epoch 已过期，旧进程不能提交结果",
        409,
      );
    }
  }

  release(
    workspacePath: string,
    owner: string,
    epoch: number,
    stopProofConfirmed = true,
  ): WorkspaceAccess {
    const workspaceId = canonicalWorkspaceId(workspacePath);
    return this.store.transaction(() => {
      const current = this.store.get<WorkspaceAccess>(
        "workspace_access",
        workspaceId,
      );
      if (!current) {
        throw new DomainError("workspace_lock_missing", "工作区访问记录不存在", 404);
      }
      const now = new Date().toISOString();
      if (!stopProofConfirmed) {
        const locked: WorkspaceAccess = {
          ...current,
          status: "needs-reconciliation",
          updatedAt: now,
          note: "process_stop_unconfirmed",
        };
        this.store.put("workspace_access", locked);
        return locked;
      }
      const remaining = current.holders.filter(
        (h) => !(h.owner === owner && h.epoch === epoch),
      );
      const next: WorkspaceAccess = {
        ...current,
        holders: remaining,
        status: remaining.length ? "active" : "released",
        owner: remaining[0]?.owner ?? current.owner,
        mode: remaining[0]?.mode ?? current.mode,
        updatedAt: now,
      };
      this.store.put("workspace_access", next);
      return next;
    });
  }

  /**
   * Never release active write/intervention locks based on TTL or controller restart.
   * Any active non-readonly lock (or active lock whose controller died) enters needs-reconciliation.
   */
  recoverOnControllerRestart(controllerId: string): WorkspaceAccess[] {
    return this.store.transaction(() => {
      const updated: WorkspaceAccess[] = [];
      const now = new Date().toISOString();
      for (const item of this.store.list<WorkspaceAccess>("workspace_access")) {
        if (item.status !== "active") continue;
        const hasWriter = item.holders.some((h) => h.mode !== "read-only");
        if (
          hasWriter ||
          item.processIdentity?.controllerId !== controllerId
        ) {
          const reconciled: WorkspaceAccess = {
            ...item,
            status: "needs-reconciliation",
            updatedAt: now,
            note: "controller_restarted_without_stop_proof",
          };
          this.store.put("workspace_access", reconciled);
          updated.push(reconciled);
        }
      }
      return updated;
    });
  }

  reconcile(
    workspacePath: string,
    stoppedConfirmed: boolean,
    note: string,
  ): WorkspaceAccess {
    if (!stoppedConfirmed || note.trim().length < 10) {
      throw new DomainError(
        "recovery_proof_required",
        "必须确认遗留进程已停止并提供至少 10 字的核对依据",
        422,
      );
    }
    const workspaceId = canonicalWorkspaceId(workspacePath);
    return this.store.transaction(() => {
      const current = this.store.get<WorkspaceAccess>(
        "workspace_access",
        workspaceId,
      );
      if (!current) {
        throw new DomainError("workspace_lock_missing", "工作区访问记录不存在", 404);
      }
      const next: WorkspaceAccess = {
        ...current,
        status: "released",
        holders: [],
        updatedAt: new Date().toISOString(),
        note,
      };
      this.store.put("workspace_access", next);
      return next;
    });
  }
}
