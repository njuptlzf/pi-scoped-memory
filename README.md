# pi-scoped-memory

Minimal long-term memory extension for [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`).

[中文](./README.zh.md) · [Why not hermes (English)](./WHY-NOT-HERMES.en.md) · [为什么不用 hermes（中文）](./WHY-NOT-HERMES.md)

---

> **Positioning in one line.**
> This is not "a memory plugin with multi-tenancy added". It is a minimal
> implementation that **takes the scope decision out of the plugin and hands it
> back to the host**. Isolation comes from a single contract: *the host passes
> one already-computed directory per session*. The plugin itself manages no
> tenants, no identities, no projects.

```text
   host knows identity            plugin knows only
        │                            │
        ├─ userId ─────┐             │
        ├─ tenant ─────┤             │
        └─ scope  ─────┴─► dir ──────┼──► entries.jsonl
                                     │
                     remember · recall · forget · inject
```

## At a glance

| | |
|---|---|
| Shape | One file — `src/index.ts` (~396 lines) |
| Runtime imports | `node:fs`, `node:path`, `typebox` |
| Native modules | none |
| Databases | none |
| Subprocesses | none |
| Dependencies | peer-only: `@earendil-works/pi-coding-agent`, `typebox` |
| Storage | append-only `entries.jsonl` |
| Tenant awareness | none |

## Quickstart

One factory per session — `dir` is the scope.

```ts
import { scopedMemory } from "pi-scoped-memory";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

new DefaultResourceLoader({
  extensionFactories: [scopedMemory({ dir: `./memory/${userId}` })],
});
```

Single-user CLI? `pi install npm:pi-scoped-memory`. Full wiring and CLI wrapper
are under [Usage](#usage).

## When to use it

One test decides it: **can two identities ever appear in the same process?**

### Use `pi-scoped-memory` when

- One server process serves many `userId`s per request (embedded multi-tenant backend).
- Only the host knows the partition key (tenant id / qualification / store / team).
- You owe per-user erasure, export or audit — account deletion is `rm -rf` on one directory.
- You cannot carry a native dependency (`better-sqlite3`) or a consolidation subprocess.
- You refuse to let the model choose where a memory belongs.

### Use `pi-hermes-memory` instead when

- Single-user coding agent: local CLI, one person, one machine, one agent root.
- "Project" genuinely is the scope (real git repo, meaningful `cwd`).
- Entries grow into the thousands and you need semantic recall with relevance-ranked injection.
- You need automatic dedup / conflict resolution / consolidation.

**The other way around**: if your deployment already runs one process per user, the
multi-tenancy argument disappears — use hermes and take its retrieval and
consolidation quality instead.

**Installing both is not a hedge either.** Coexistence degrades the boundary from
*"the host passes the right `dir`"* to *"the model picks the right `target`"* — see
[WHY-NOT-HERMES.en.md](./WHY-NOT-HERMES.en.md), end of section 1.

The full argument — including why an adapter wrapping hermes does not work, and
when it is worth looking back at it — is in [WHY-NOT-HERMES.en.md](./WHY-NOT-HERMES.en.md).

## What it does

### Tools (model-invoked)

- **`remember`** — store one point, at most 500 characters, with an optional `kind`
  tag (`preference` / `correction` / `failure` / `fact`). Re-storing the same text
  does not duplicate it: reads dedupe by text (case-insensitive) with the latest
  write winning.
- **`recall`** — filter by keyword and rank by score
  (occurrence count > kind match > earlier hit; time only breaks ties). Returns the
  top hits (default 10, capped at 50).
- **`forget`** — delete one remembered point. `text` must match the original;
  implemented as an appended tombstone line (append-only, cross-process safe),
  cleaned together with the hidden line at compaction. Re-`remember`ing the same
  text later makes it visible again.

### Events

- **Correction hint** — `before_agent_start` matches the last user prompt against
  correction phrasing ("不对" / "错了" / "别再" / "应该是" …) and appends one hint
  line asking the model to `remember` it as `kind=correction`. Ordinary turns
  inject nothing, so it costs no tokens.
- **Auto-capture** (opt-in, `autoCapture`) — every Nth turn (default 10) one
  `completeSimple` call offers the latest turn to the model for at most one
  durable point, which then goes through `hasSecret`, dedupe and the cap. Off by
  default because it adds one completion per N turns. `capture` is injectable for
  hosts/tests.
- **Snapshot injection** — `before_agent_start` appends the **snapshot** to
  `event.systemPromptOptions.appendSystemPrompt`, wrapped in `<user-memory>`. An
  empty snapshot injects nothing.

### Storage model

- One file: `<dir>/entries.jsonl`.
- Each entry is **one O_APPEND write** — concurrent writers in different processes
  lose nothing (probe: 4 writers × 300 entries → 347/1200 survived with the old
  whole-file rewrite; the append-only path survives).
- Roll by count (default 200): the log may grow to 1.5× before it is compacted
  once, while the visible set stays capped.
- Injection is capped at the latest 60 entries and 4000 characters total
  (filled newest-first; the entry that does not fit is truncated, not dropped).
- Prompt-cache friendly — the snapshot is refreshed lazily by file fingerprint
  (`mtime+size`), so the injected text only changes when the entries do.

The tool descriptions tell the model to record only preferences, corrections or
conclusions the user stated as worth following across sessions — never one-off
question content or the wording of an exercise. There is no explicit "wake up
and save" flow.

## Usage

### A. SDK host — the correct shape for a multi-user service

Construct one factory per session; the scope is computed host-side.

```ts
import * as path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { scopedMemory } from "pi-scoped-memory"; // while hacking in this repo: ./src/index.ts

const loader = new DefaultResourceLoader({
  // ...
  extensionFactories: [
    scopedMemory({ dir: path.join(dataDir, "memory", userId, qualification || "default") }),
  ],
});
```

The point: **one factory instance per session**. If two users share one instance
they share one directory — isolation is the host's responsibility and the library
will not verify it for you. A real host wiring lives at
`packages/server/src/session.ts:420-426` in the agent-chat monorepo, guarded by
two integration tests (see [Release](#release)).

### B. Single-user CLI — to try it out

pi's file discovery requires an extension to `export default function (pi: ExtensionAPI)`,
while this package exports a factory that **returns** a factory (because
multi-tenant hosts must construct one per session). So CLI use goes through the
thin wrapper [`extensions/scoped-memory.ts`](./extensions/scoped-memory.ts), which
pins `dir`: it reads `PI_SCOPED_MEMORY_DIR` (empty or whitespace-only counts as
unset) and falls back to `~/.pi/agent/memory`.

```bash
pi install npm:pi-scoped-memory                                     # from npm (listed in the pi gallery)
pi --extension ./extensions/scoped-memory.ts                        # straight from this repo root
```

Multi-user hosts must **not** take path B: the wrapper resolves `dir` once per
process, so every session would share one directory.

## API

| Export | Description |
|---|---|
| `scopedMemory(options: ScopedMemoryOptions)` | Returns a pi extension factory (pi's `ExtensionFactory` shape). `options.dir` is required and created on first write; `options.maxEntries` defaults to 200; `options.autoCapture` (default false), `options.autoCaptureEvery` (default 10) and `options.capture` are described under auto-capture. |
| `MemoryEntry` | `{ at: number; kind: string; text: string }` |
| `cleanEntryText(text)` | Trust-boundary sanitisation: collapse whitespace, cap at 500 chars, strip `<user-memory>` tags (context fencing). |
| `hasSecret(text)` | Cheap pre-write key/password screening (rejects, never stored). |
| `turnTranscript(messages)` / `defaultCapture(transcript, model)` | Turn extraction and the default completion for auto-capture (dynamic `pi-ai/compat` import; zero dependency when unused). |
| `loadEntries(file)` / `appendEntry(file, entry, max)` / `recallEntries(entries, q, limit)` / `renderMemorySection(entries)` | Pure functions, individually testable. |

The absolute `dir` path **never enters the prompt**; injected text contains only
dates and entry bodies. Note that all model-facing strings (tool descriptions,
labels, the injected guidance line) are currently Chinese — see
`src/index.ts:105`, `:123-129`, `:142-147`.

## Boundaries and security

- pi's own docs state that extensions *"run inside the Pi process with the same
  OS permissions … only load sources you trust"* (`docs/extensions.md`). This
  library provides no sandbox; outside `dir` it touches nothing.
- Stored text is injected into the system prompt, i.e. it is an indirect
  prompt-injection surface. Mitigations present: 500-char cap per entry,
  `</user-memory>` stripping, 60-entry injection cap. Not present: poisoning
  detection, human confirmation on write (an apparent secret is rejected at
  write time).
- A multi-user host must guarantee **different `dir` values for different
  sessions in the same process**. The library reads no environment variables and
  guesses no identities, so it also cannot stop you from passing the wrong
  directory.

## Known ceilings (deliberate)

- `recall` is case-insensitive **substring matching**, not semantic search.
- Rolling is **count-based** eviction, not LLM consolidation. The same point
  stored twice dedupes on read, but its historical log lines survive until
  compaction.
- Compaction (rewriting the log down to the cap) is best effort: a racing writer
  may be dropped from this round; the log shrinks later. Corrupt lines are only
  dropped during compaction.
- Injection is "the latest N within a character budget", not relevance-selected
  (`recall` is the ranked path).

If memory quality becomes the bottleneck, the upgrade path is a consolidation
pass / semantic index **on top of** `entries.jsonl`: storage shape unchanged,
scope contract unchanged, host code untouched. That path is recorded in the
source comment (`ponytail:`).

## Release

**Published.** npm [`pi-scoped-memory`](https://www.npmjs.com/package/pi-scoped-memory)
`0.2.0` (latest; `0.1.0` was the first release) + GitHub
[`njuptlzf/pi-scoped-memory`](https://github.com/njuptlzf/pi-scoped-memory), MIT
(`Copyright (c) 2026 njuptlzf`).

`0.2.0` adds: append-only concurrent-safe writes, lazily refreshed snapshots,
ranked recall, an injection character budget, read-time dedupe, a kind enum,
secret rejection, `forget` tombstones, the correction hint, and `autoCapture`
(off by default).

Publish / view with an explicit
`--registry=https://registry.npmjs.org` — the local default registry is
npmmirror and will refuse.

### What's in the tarball

- `package.json` — `pi.extensions` + `keywords: ["pi-package"]`. The
  host-provided `@earendil-works/pi-coding-agent` and `typebox` are declared as
  `peerDependencies: "*"` and **not** in `dependencies` — see pi's
  `docs/packages.md`.
- `src/index.ts` (~396 lines) — the published artefact is the TypeScript source,
  loaded by pi's extension loader. There is no build step.
- `extensions/scoped-memory.ts` — the CLI wrapper.
- The four docs (`README.md`, `README.zh.md`, `WHY-NOT-HERMES.md`,
  `WHY-NOT-HERMES.en.md`).

`test/` and `tsconfig.json` live in the repository but are excluded from the
tarball by `files`. To run the 16 tests: clone, `npm install && npm test` —
sanitisation / corrupt-line + rolling / **concurrent cross-process appends lose
nothing** / substring recall with ranking and duplicate collapsing / **a forget
tombstone hides the old point and a later write revives it** / correction
heuristic / **auto-capture fires on cadence and is injectable** / injection line
cap and character budget, no path leakage / fake-pi structure / **two directories
that cannot see each other** / **two sessions on one directory see each other**
/ wrapper directory resolution.

### Where it came from

This repository is the **single source of truth**. Its parent project, the
agent-chat monorepo, imports `src/index.ts` from here
(`packages/server/src/session.ts`), and the old
`packages/server/src/extensions/scoped-memory.ts` was moved out with `git mv` —
there is no second copy. The two host-side integration tests (storage lands
under `(userId, scope)`; `agent.memory: false` registers no tools) stay in
`packages/server/test/memory.test.ts`, because they assert the host contract,
not this package. Original implementation commit: `c40f503`; the decision record
is the S2-5 row of the project handoff doc (Chinese), under `docs/` of the
agent-chat repository ([docs directory](https://github.com/njuptlzf/agent-chat/tree/main/docs)).
