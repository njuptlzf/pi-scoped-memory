import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * pi-scoped-memory — a minimal long-term memory extension for pi.
 *
 * The contract is deliberately tiny: the plugin only knows a DIRECTORY. All
 * identity / tenant / project partitioning stays the host's job — the host
 * computes e.g. `<dataDir>/memory/<userId>/<scope>/` and calls `scopedMemory`
 * once per session with that directory. Two sessions with different dirs never
 * see each other's entries; two sessions sharing one factory instance (same
 * options) share one file — the library does not verify identity for you.
 *
 * Why it is not a wrapper around pi-hermes-memory: hermes' storage root is an
 * import-time module constant (process-shared), and its prompt routing rules
 * teach the model to write preferences/corrections to the *global* layer. Both
 * are outside what an adapter can reach. See WHY-NOT-HERMES.md.
 *
 * Two capture/injection points, both model-invoked (no explicit "save" flow):
 *   - tools `remember` / `recall`,
 *   - a frozen snapshot injected into the system prompt at before_agent_start.
 *
 * Known ceilings (ponytail): recall is substring scoring, not semantic;
 * rolling is count-based, no LLM consolidation; all model-facing strings are
 * Chinese (src/index.ts:105, :123-129, :142-147). The upgrade path if memory
 * quality becomes the bottleneck is a consolidation pass over entries.jsonl,
 * not a rewrite.
 */

export interface ScopedMemoryOptions {
  /** Directory this plugin owns; created on first write. Never rendered into the prompt. */
  dir: string;
  /** Rolling cap: oldest entries are dropped first. */
  maxEntries?: number;
}

export interface MemoryEntry {
  at: number; // epoch ms
  kind: string; // free-form category ("preference" | "correction" | ...)
  text: string;
}

const FILE = "entries.jsonl";
const DEFAULT_MAX = 200;
const MAX_TEXT = 500;

/** Sanitize at the trust boundary: model-supplied text becomes storage-safe. */
export function cleanEntryText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT)
    // context fencing: a stored line must not fake the end of its section
    .replace(/<\/?user-memory>/gi, "");
}

export function loadEntries(file: string): MemoryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as MemoryEntry;
      if (typeof e.at === "number" && typeof e.text === "string" && e.text) out.push({ at: e.at, kind: typeof e.kind === "string" ? e.kind : "", text: e.text });
    } catch {
      /* skip one corrupt line; never fail the session over it */
    }
  }
  return out;
}

/** Append with rolling cap; returns the new snapshot. Atomic-ish: full rewrite via temp+rename. */
export function appendEntry(file: string, entry: MemoryEntry, maxEntries: number): MemoryEntry[] {
  const next = [...loadEntries(file), entry];
  const kept = next.slice(Math.max(0, next.length - maxEntries));
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, file);
  return kept;
}

export function recallEntries(entries: MemoryEntry[], query: string, limit: number): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? entries.filter((e) => e.text.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q))
    : entries;
  return hits.slice(Math.max(0, hits.length - limit));
}

export function renderMemorySection(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries
    .slice(-60) // injection cap: the prompt pays for every stored byte
    .map((e) => `- [${new Date(e.at).toISOString().slice(0, 10)}${e.kind ? ` ${e.kind}` : ""}] ${e.text}`);
  return [
    "<user-memory>",
    "以下是本作用域内此前记住的偏好与纠错要点，回答时遵循它们：",
    ...lines,
    "</user-memory>",
  ].join("\n");
}

/** Build a per-session extension factory. The host calls this once per session
 *  with the tenant/scope directory already resolved. */
export function scopedMemory(options: ScopedMemoryOptions) {
  const max = options.maxEntries ?? DEFAULT_MAX;
  const file = path.join(options.dir, FILE);
  return function scopedMemoryExtension(pi: ExtensionAPI) {
    // Frozen snapshot: read at session build; refresh on write. Keeps the
    // before_agent_start injection stable for pi's prompt cache.
    let snapshot = loadEntries(file);

    pi.registerTool({
      name: "remember",
      label: "记住",
      description:
        "当用户表达了值得跨会话遵循的偏好、纠错或结论（如回答格式、错题复盘习惯、被指正的事实）时，主动调用记录一条简短中文要点。不要记录一次性问题内容、题目原文或未经用户确认的猜测。",
      promptSnippet: "remember: 记录用户偏好/纠错，跨会话生效",
      parameters: Type.Object({
        text: Type.String({ description: "要记住的要点，一条一句话，不超过 500 字符" }),
        kind: Type.Optional(Type.String({ description: "类别标签，如 preference / correction" })),
      }),
      async execute(_id, params) {
        const text = cleanEntryText(String(params.text ?? ""));
        if (!text) return { content: [{ type: "text", text: "内容为空，未记录。" }], details: { count: snapshot.length } };
        const kind = cleanEntryText(String(params.kind ?? "")).slice(0, 40);
        snapshot = appendEntry(file, { at: Date.now(), kind, text }, max);
        return { content: [{ type: "text", text: `已记录（当前共 ${snapshot.length} 条）。` }], details: { count: snapshot.length } };
      },
    });

    pi.registerTool({
      name: "recall",
      label: "回忆",
      description: "查询此前记住的要点（可按关键词过滤，返回最近的若干条）。",
      promptSnippet: "recall: 查询用户的长期偏好与纠错记录",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "关键词过滤，留空返回最近的条目" })),
        limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 10" })),
      }),
      async execute(_id, params) {
        const hits = recallEntries(snapshot, String(params.query ?? ""), Math.min(Number(params.limit ?? 10) || 10, 50));
        const text = hits.length === 0 ? "没有匹配的记忆条目。" : hits.map((e) => `- [${new Date(e.at).toISOString().slice(0, 10)}${e.kind ? ` ${e.kind}` : ""}] ${e.text}`).join("\n");
        return { content: [{ type: "text", text }], details: { count: hits.length } };
      },
    });

    pi.on("before_agent_start", (event) => {
      const section = renderMemorySection(snapshot);
      if (!section) return undefined;
      const cur = event.systemPromptOptions.appendSystemPrompt;
      event.systemPromptOptions.appendSystemPrompt = cur ? `${cur}\n\n${section}` : section;
      return undefined;
    });
  };
}
