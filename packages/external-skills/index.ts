import { randomUUID, createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { DomainError } from "../domain/index.js";
import { Store } from "../persistence/index.js";

type Source = { id: string; path: string; createdAt: string; lastScannedAt: string | null };
type Entry = {
  id: string;
  sourceId: string;
  relativePath: string;
  name: string;
  description: string;
  contentDigest: string;
  status: "available" | "missing";
  lastScannedAt: string;
};
const excluded = new Set([".git", "node_modules", ".venv", "dist", "build"]);
const maxSkillBytes = 128 * 1024;
const maxEntries = 4000;
const maxDepth = 6;
const maxSkills = 300;

function assertInside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new DomainError("skill_path_escape", "Skill路径超出授权扫描目录", 422);
}

function parseSkill(text: string): { name: string; description: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---")
    throw new DomainError("invalid_skill", "SKILL.md缺少YAML元数据", 422);
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0 || end > 100)
    throw new DomainError("invalid_skill", "SKILL.md元数据未正确结束", 422);
  const headers = lines.slice(1, end);
  function value(key: string) {
    const index = headers.findIndex((line) => line.startsWith(key + ":"));
    if (index < 0) return "";
    const original = headers[index].slice(key.length + 1).trim();
    if (/^[>|][-+0-9]*$/.test(original)) {
      const parts: string[] = [];
      for (let i = index + 1; i < headers.length; i++) {
        if (headers[i] && !/^\s/.test(headers[i])) break;
        parts.push(headers[i].trim());
      }
      return parts.join(original.startsWith(">") ? " " : "\n").trim();
    }
    if ((original.startsWith('"') && original.endsWith('"')) ||
        (original.startsWith("'") && original.endsWith("'")))
      return original.slice(1, -1);
    return original;
  }
  const name = value("name");
  const description = value("description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 ||
      !description || description.length > 1024)
    throw new DomainError("invalid_skill", "Skill需要有效的name及description", 422);
  return { name, description };
}

function readSkill(root: string, relativePath: string) {
  const file = join(root, relativePath, "SKILL.md");
  try {
    if (lstatSync(file).isSymbolicLink())
      throw new DomainError("skill_symlink", "不允许通过符号链接读取SKILL.md", 422);
    const canonical = realpathSync(file);
    assertInside(root, canonical);
    const stats = statSync(canonical);
    if (!stats.isFile() || stats.size > maxSkillBytes)
      throw new DomainError("skill_file_size", "SKILL.md大小或类型不支持", 422);
    const content = readFileSync(canonical, "utf8");
    const metadata = parseSkill(content);
    return {
      ...metadata,
      content,
      contentDigest: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("skill_unavailable", "外部Skill无法读取，请检查目录并重新扫描", 422);
  }
}

export class ExternalSkillService {
  constructor(public store: Store) {}

  sources(): Source[] { return this.store.list<Source>("external_skill_source"); }
  skills(): Entry[] { return this.store.list<Entry>("external_skill"); }

  register(input: unknown) {
    const { path } = z.object({ path: z.string().trim().min(1).max(2048) }).parse(input);
    if (!isAbsolute(path))
      throw new DomainError("absolute_path_required", "请输入本机绝对目录路径", 422);
    let root: string;
    try {
      root = realpathSync(path);
      if (!statSync(root).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new DomainError("invalid_skill_source", "扫描目录不存在或不可访问", 422);
    }
    const existing = this.sources().find((s) => s.path === root);
    if (existing) return this.scan(existing.id);
    const source: Source = { id: randomUUID(), path: root, createdAt: new Date().toISOString(), lastScannedAt: null };
    return this.store.transaction(() => {
      this.store.put("external_skill_source", source);
      return this.scan(source.id);
    });
  }

  scan(id: string) {
    const source = this.store.get<Source>("external_skill_source", id);
    if (!source) throw new DomainError("not_found", "Skill扫描来源不存在", 404);
    let root: string;
    try {
      root = realpathSync(source.path);
      if (root !== source.path || !statSync(root).isDirectory())
        throw new Error("source path changed");
    } catch {
      throw new DomainError("skill_source_missing", "扫描来源已移动或不可访问", 422);
    }
    const found = new Map<string, ReturnType<typeof readSkill>>();
    const warnings: string[] = [];
    const dirs = [{ dir: root, depth: 0 }];
    let visited = 0;
    while (dirs.length) {
      const { dir, depth } = dirs.shift()!;
      if (++visited > maxEntries)
        throw new DomainError("scan_limit", "目录过大，请指定更小的Skill目录", 422);
      const rel = relative(root, dir).split(sep).join("/");
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
          try { found.set(rel, readSkill(root, rel)); }
          catch (error) { warnings.push(rel + ": " + (error as Error).message); }
          if (found.size > maxSkills)
            throw new DomainError("scan_limit", "Skill数量超过上限", 422);
          continue;
        }
        if (depth >= maxDepth) continue;
        for (const entry of entries) {
          if (entry.isSymbolicLink()) {
            warnings.push(join(dir, entry.name) + ": 跳过符号链接，请单独授权目标目录");
          } else if (entry.isDirectory() && !excluded.has(entry.name)) {
            dirs.push({ dir: join(dir, entry.name), depth: depth + 1 });
          }
        }
      } catch (error) {
        if (error instanceof DomainError) throw error;
        warnings.push(rel + ": 目录无法读取");
      }
    }
    const now = new Date().toISOString();
    const old = this.skills().filter((s) => s.sourceId === id);
    this.store.transaction(() => {
      for (const previous of old)
        if (!found.has(previous.relativePath))
          this.store.put("external_skill", { ...previous, status: "missing", lastScannedAt: now });
      for (const [relativePath, skill] of found) {
        const previous = old.find((s) => s.relativePath === relativePath);
        const entry: Entry = {
          id: previous?.id ?? randomUUID(), sourceId: id, relativePath,
          name: skill.name, description: skill.description,
          contentDigest: skill.contentDigest, status: "available", lastScannedAt: now,
        };
        this.store.put("external_skill", entry);
      }
      this.store.put("external_skill_source", { ...source, lastScannedAt: now });
    });
    return {
      source: this.store.get<Source>("external_skill_source", id),
      found: found.size,
      missing: old.filter((s) => !found.has(s.relativePath)).length,
      warnings,
    };
  }

  snapshot(ids: string[]) {
    return ids.map((id) => {
      const entry = this.store.get<Entry>("external_skill", id);
      if (!entry || entry.status !== "available")
        throw new DomainError("external_skill_missing", "引用的外部Skill不可用，请重新扫描", 422);
      const source = this.store.get<Source>("external_skill_source", entry.sourceId);
      if (!source)
        throw new DomainError("external_skill_source_missing", "Skill来源不存在", 422);
      const skill = readSkill(source.path, entry.relativePath);
      const directoryPath = realpathSync(join(source.path, entry.relativePath));
      assertInside(source.path, directoryPath);
      return {
        id: entry.id,
        kind: "skill" as const,
        name: skill.name,
        description: skill.description,
        version: "external",
        projectId: null,
        taskType: "development" as const,
        sources: [join(directoryPath, "SKILL.md")],
        content: skill.content,
        contentDigest: skill.contentDigest,
        createdAt: entry.lastScannedAt,
        external: { sourceId: source.id, relativePath: entry.relativePath, directoryPath },
      };
    });
  }
}
