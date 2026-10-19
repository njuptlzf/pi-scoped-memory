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
 *   - a snapshot injected into the system prompt at before_agent_start,
 *     re-read lazily when the log's fingerprint changes (other sessions write too).
 *
 * Known ceilings (ponytail): recall is substring scoring, not semantic;
 * rolling is count-based, no LLM consolidation; compaction after the 1.5× cap is
 * best effort and may lose a racing append (the log shrinks later). All
 * model-facing strings are Chinese. The upgrade path if memory quality becomes
 * the bottleneck is a consolidation pass over entries.jsonl, not a rewrite.
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
/** The log may grow to 1.5× the cap before it is rewritten: appends are the hot,
 *  cross-process-safe path, compaction is the rare one. */
const COMPACT_FACTOR = 1.5;

/** Sanitize at the trust boundary: model-supplied text becomes storage-safe. */
export function cleanEntryText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT)
    // context fencing: a stored line must not fake the end of its section
    .replace(/<\/?user-memory>/gi, "");
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:api[_-]?key|secret|token|password|passwd|密码|口令|密钥)\s*[:=：]\s*\S{6,}/i,
];

/** Cheap pre-write guard. A stored key is injected into every later prompt, so
 *  reject outright: a half-masked secret still says "a password exists here". */
export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function loadEntries(file: string): MemoryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  const tombstones: { at: number; key: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as MemoryEntry & { forget?: string };
      if (typeof e.at === "number" && typeof e.forget === "string") {
        tombstones.push({ at: e.at, key: e.forget.toLowerCase() });
      } else if (typeof e.at === "number" && typeof e.text === "string" && e.text) {
        out.push({ at: e.at, kind: typeof e.kind === "string" ? e.kind : "", text: e.text });
      }
    } catch {
      /* skip one corrupt line; never fail the session over it */
    }
  }
  // Dedupe on read (newest wins): the log is append-only, so re-remembering the
  // same point appends a line instead of rewriting — last write is the live one.
  const seen = new Set<string>();
  const unique: MemoryEntry[] = [];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    const key = e.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.unshift(e);
  }
  // A forget is a tombstone line: it hides entries appended before it, and a later
  // re-remember of the same text (larger `at`) is visible again — no rewrite needed.
  const forgottenAt = new Map<string, number>();
  for (const t of tombstones) {
    const at = forgottenAt.get(t.key) ?? 0;
    if (t.at > at) forgottenAt.set(t.key, t.at);
  }
  return unique.filter((e) => (forgottenAt.get(e.text.toLowerCase()) ?? 0) < e.at);
}

/** Identity of the on-disk log; a changed stamp means another session/process wrote. */
function logStamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Rewrite the log down to `maxEntries`. Best effort only: a concurrent writer can
 *  append to the inode we rename away, and the rename itself can throw EPERM/ENOENT
 *  on Windows. Both are tolerated — the log just shrinks a little later. */
function compact(file: string, maxEntries: number): MemoryEntry[] {
  const kept = loadEntries(file).slice(-maxEntries);
  // pid-suffixed: two processes must never share one rename source
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
    return kept;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* leftover temp file is harmless */
    }
    return loadEntries(file);
  }
}

/** Append one line with a single O_APPEND write, then trim lazily.
 *  One small append per call is atomic across processes; rewriting the whole file
 *  per call was not (probe: 4 writers × 300 entries → 347/1200 survived). */
export function appendEntry(file: string, entry: MemoryEntry, maxEntries: number): MemoryEntry[] {
  const line = JSON.stringify(entry) + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, "utf8");
  const entries = loadEntries(file);
  const kept = entries.length > maxEntries * COMPACT_FACTOR ? compact(file, maxEntries) : entries;
  return kept.slice(Math.max(0, kept.length - maxEntries));
}

/** Append a tombstone for one exact point (append-only, so it is safe across
 *  processes); compaction later drops both the tombstone and the hidden line. */
export function forgetEntry(file: string, text: string, maxEntries: number): MemoryEntry[] {
  const cleaned = cleanEntryText(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), forget: cleaned }) + "\n", "utf8");
  const entries = loadEntries(file);
  return entries.slice(Math.max(0, entries.length - maxEntries));
}

/** Rank matches: more occurrences > kind match > earlier hit, newest breaks ties.
 *  Still substring matching, not retrieval — see the ceilings in the header. */
export function recallEntries(entries: MemoryEntry[], query: string, limit: number): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(Math.max(0, entries.length - limit));
  const scored: Array<{ entry: MemoryEntry; score: number }> = [];
  for (const entry of entries) {
    const text = entry.text.toLowerCase();
    let hits = 0;
    for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) hits++;
    const kindHit = entry.kind.toLowerCase().includes(q);
    if (!hits && !kindHit) continue;
    scored.push({ entry, score: hits * 10 + (kindHit ? 5 : 0) + (text.startsWith(q) ? 3 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.at - a.entry.at);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.entry);
}

const INJECT_LINES = 60;
/** Character budget for the injected block: the prompt pays for every stored byte. */
const INJECT_BUDGET = 4000;

export function renderMemorySection(entries: MemoryEntry[], budget = INJECT_BUDGET): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0 && lines.length < INJECT_LINES; i--) {
    const entry = entries[i]!;
    const head = `- [${new Date(entry.at).toISOString().slice(0, 10)}${entry.kind ? ` ${entry.kind}` : ""}] `;
    const full = head + entry.text;
    const room = budget - used;
    if (full.length > room) {
      // keep the newest entry partially rather than dropping it whole
      if (room > head.length) lines.unshift(head + entry.text.slice(0, room - head.length));
      break;
    }
    lines.unshift(full);
    used += full.length + 1; // + newline
  }
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
    // Snapshot kept for prompt-cache stability: the injected text only changes
    // when the log actually changed (this session's write, or another session's).
    let snapshot = loadEntries(file).slice(-max);
    let stamp = logStamp(file);

    /** Re-read only when the log changed on disk; identical content ⇒ identical
     *  prompt text, so a touch/rewrite with the same entries does not churn cache. */
    function freshEntries(): MemoryEntry[] {
      const next = logStamp(file);
      if (next !== stamp) {
        stamp = next;
        snapshot = loadEntries(file).slice(-max);
      }
      return snapshot;
    }

    pi.registerTool({
      name: "remember",
      label: "记住",
      description:
        "当用户表达了值得跨会话遵循的偏好、纠错或结论（如回答格式、错题复盘习惯、被指正的事实）时，主动调用记录一条简短中文要点。不要记录一次性问题内容、题目原文或未经用户确认的猜测。",
      promptSnippet: "remember: 记录用户偏好/纠错，跨会话生效",
      parameters: Type.Object({
        text: Type.String({ description: "要记住的要点，一条一句话，不超过 500 字符" }),
        kind: Type.Optional(
          Type.Union([Type.Literal("preference"), Type.Literal("correction"), Type.Literal("failure"), Type.Literal("fact")], {
            description: "类别：preference 偏好、correction 纠错、failure 教训、fact 事实",
          }),
        ),
      }),
      async execute(_id, params) {
        const text = cleanEntryText(String(params.text ?? ""));
        if (!text) return { content: [{ type: "text", text: "内容为空，未记录。" }], details: { count: snapshot.length } };
        if (hasSecret(text)) {
          return {
            content: [{ type: "text", text: "疑似包含密钥/口令，未记录。请改写为不含敏感值的偏好描述。" }],
            details: { count: snapshot.length },
          };
        }
        const kind = cleanEntryText(String(params.kind ?? "")).slice(0, 40);
        snapshot = appendEntry(file, { at: Date.now(), kind, text }, max);
        stamp = logStamp(file);
        return { content: [{ type: "text", text: `已记录（当前共 ${snapshot.length} 条）。` }], details: { count: snapshot.length } };
      },
    });

    pi.registerTool({
      name: "forget",
      label: "忘掉",
      description: "删除此前记住的一条要点（用户要求忘掉或更正错误记忆时调用）。text 需与 remember 时一致，可先用 recall 查到原文再传。",
      promptSnippet: "forget: 删除一条错误/过期的记忆（需原文）",
      parameters: Type.Object({ text: Type.String({ description: "要忘掉的要点原文（与 remember 时一致）" }) }),
      async execute(_id, params) {
        const text = cleanEntryText(String(params.text ?? ""));
        if (!text) return { content: [{ type: "text", text: "内容为空，未删除。" }], details: { count: snapshot.length } };
        const existed = freshEntries().some((e) => e.text.toLowerCase() === text.toLowerCase());
        if (!existed) return { content: [{ type: "text", text: "未找到与原文完全一致的记忆条目，未删除。" }], details: { count: snapshot.length } };
        snapshot = forgetEntry(file, text, max);
        stamp = logStamp(file);
        return { content: [{ type: "text", text: `已删除（当前共 ${snapshot.length} 条）。` }], details: { count: snapshot.length } };
      },
    });

    pi.registerTool({
      name: "recall",
      label: "回忆",
      description: "查询此前记住的要点（可按关键词过滤，按命中打分排序返回）。",
      promptSnippet: "recall: 查询用户的长期偏好与纠错记录",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "关键词过滤，留空返回最近的条目" })),
        limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 10" })),
      }),
      async execute(_id, params) {
        const hits = recallEntries(freshEntries(), String(params.query ?? ""), Math.min(Number(params.limit ?? 10) || 10, 50));
        const text = hits.length === 0 ? "没有匹配的记忆条目。" : hits.map((e) => `- [${new Date(e.at).toISOString().slice(0, 10)}${e.kind ? ` ${e.kind}` : ""}] ${e.text}`).join("\n");
        return { content: [{ type: "text", text }], details: { count: hits.length } };
      },
    });

    pi.on("before_agent_start", (event) => {
      const section = renderMemorySection(freshEntries());
      if (!section) return undefined;
      const cur = event.systemPromptOptions.appendSystemPrompt;
      event.systemPromptOptions.appendSystemPrompt = cur ? `${cur}\n\n${section}` : section;
      return undefined;
    });
  };
}
