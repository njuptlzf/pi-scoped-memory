# pi-scoped-memory

[中文 README](./README.md) · **English** · [Why not hermes (English)](./WHY-NOT-HERMES.en.md) / [为什么不用 hermes（中文）](./WHY-NOT-HERMES.md)

A minimal long-term memory extension for [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`): two model-invoked tools, `remember` / `recall`, plus injection of stored points into the system prompt at session start.

One file. Three runtime imports: `node:fs`, `node:path`, `typebox`. No database, no native modules, no subprocess. **It knows nothing about tenants, identities or projects.**

> **Positioning in one line**: this is not "a memory plugin with multi-tenancy added" — it is a minimal implementation that **takes the scope decision out of the plugin and hands it back to the host**. Isolation comes from the contract "the host passes one already-computed directory per session"; the plugin itself does not manage tenants.

## Why that is worth stating

Most pi memory extensions (including `pi-hermes-memory`) encode "which file should this memory go to" inside the plugin: read `cwd`, read git, route by target (user / memory / failure / project). For a **single-user CLI** that is helpful automation; for an **embedded multi-user service** it is a structural cross-user leak — the plugin has no way to know who the person is, and never can.

This extension inverts it: it accepts one `dir`. The host computes `<base>/memory/<userId>/<scope>/` according to its own identity model and passes it in; the plugin writes, reads, injects, and performs no discovery. The price is no semantic retrieval and no LLM consolidation. The gain is that it can be loaded safely into a multi-user process, and published as a package with zero business knowledge in it.

## When to use this, when to use hermes-memory

One test decides it: **can two identities ever appear in the same process?**

| Use `pi-scoped-memory` | Use `pi-hermes-memory` |
|---|---|
| One server process serving many `userId`s per request (embedded multi-tenant backend) | A single-user coding agent: local CLI, one person, one machine, one agent root |
| Only the host knows the partition key (tenant id / qualification / store / team) | "Project" genuinely is the scope (real git repo, meaningful cwd) |
| You owe per-user erasure / export / audit (account deletion = `rm -rf` one directory) | Entries grow into the thousands; you need semantic recall and relevance-ranked injection |
| You cannot carry a native dependency (`better-sqlite3`) or a consolidation subprocess | You need automatic dedup / conflict resolution / consolidation |
| You refuse to let the model choose where a memory belongs (hermes' routing rules write preferences to the global directory) | Single tenant, but you want a cross-project "lessons" layer |

**The other way around**: if your deployment already runs one process per user, the multi-tenancy argument disappears — use hermes and take its retrieval and consolidation quality instead.

The full argument — including why an adapter wrapping hermes does not work, and when it is worth looking back at it — is in [WHY-NOT-HERMES.en.md](./WHY-NOT-HERMES.en.md).

**Installing both is not a hedge either**: coexistence degrades the boundary from "the host passes the right `dir`" to "the model picks the right `target`" — see [WHY-NOT-HERMES.en.md](./WHY-NOT-HERMES.en.md), end of section 1.

## What it does

- `remember` (tool, model-invoked): store one point of at most 500 characters, with an optional `kind` tag (`preference` / `correction`, free-form).
- `recall` (tool, model-invoked): filter by keyword and rank by score (occurrence count > kind match > earlier hit; time only breaks ties), returning the top hits (default 10, capped at 50).
- `before_agent_start` (event): append the **snapshot** to `event.systemPromptOptions.appendSystemPrompt`, wrapped in `<user-memory>`; an empty snapshot injects nothing.

Storage is `<dir>/entries.jsonl`: corrupt lines are skipped, **each entry is one O_APPEND write** (concurrent writers in different processes lose nothing), entries roll over by count (default 200; the log may grow to 1.5× before it is compacted once, while the visible set stays capped). Injection is capped at the latest 60 entries and 4000 characters total (filled newest-first; the entry that does not fit is truncated, not dropped). Prompt-cache friendly — the snapshot is refreshed lazily by file fingerprint (mtime+size), so the injected text only changes when the entries do.

The tool descriptions explicitly tell the model to record only preferences, corrections or conclusions the user stated as worth following across sessions — never one-off question content or the wording of an exercise. There is no explicit "wake up and save" flow.

## Usage

### A. As part of an SDK host (the correct shape for a multi-user service)

Construct one factory per session; the scope is computed host-side:

```ts
import * as path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { scopedMemory } from "pi-scoped-memory"; // while hacking inside this repo: ./src/index.ts

const loader = new DefaultResourceLoader({
  // ...
  extensionFactories: [
    scopedMemory({ dir: path.join(dataDir, "memory", userId, qualification || "default") }),
  ],
});
```

The point: **one factory instance per session**. If two users share one instance they share one directory — isolation is the host's responsibility and the library will not verify it for you. A real host wiring lives at `packages/server/src/session.ts:420-426` in the agent-chat monorepo, guarded by two integration tests (see "Release").

### B. Single-user CLI (to try it out)

pi's file discovery requires an extension to `export default function (pi: ExtensionAPI)`, while this package exports a factory that **returns** a factory (because multi-tenant hosts must construct one per session). So CLI use goes through the thin wrapper [`extensions/scoped-memory.ts`](./extensions/scoped-memory.ts), which pins `dir`: it reads `PI_SCOPED_MEMORY_DIR` (empty or whitespace-only counts as unset) and falls back to `~/.pi/agent/memory`.

```bash
pi install npm:pi-scoped-memory                                     # from npm (listed in the pi gallery)
pi --extension ./extensions/scoped-memory.ts                        # straight from this repo root
```

Multi-user hosts must **not** take path B: the wrapper resolves `dir` once per process, so every session would share one directory.

## API

| Export | Description |
|---|---|
| `scopedMemory(options: ScopedMemoryOptions)` | Returns a pi extension factory (pi's `ExtensionFactory` shape). `options.dir` is required and created on first write; `options.maxEntries` defaults to 200 |
| `MemoryEntry` | `{ at: number; kind: string; text: string }` |
| `cleanEntryText(text)` | Trust-boundary sanitisation: collapse whitespace, cap at 500 chars, strip `<user-memory>` tags (context fencing) |
| `loadEntries(file)` / `appendEntry(file, entry, max)` / `recallEntries(entries, q, limit)` / `renderMemorySection(entries)` | Pure functions, individually testable |

The absolute `dir` path **never enters the prompt**; injected text contains only dates and entry bodies. Note that all model-facing strings (tool descriptions, labels, the injected guidance line) are currently Chinese — see `src/index.ts:105, :123-129, :142-147`.

## Boundaries and security

- pi's own docs state that extensions "run inside the Pi process with the same OS permissions … only load sources you trust" (`docs/extensions.md`). This library provides no sandbox; outside `dir` it touches nothing.
- Stored text is injected into the system prompt, i.e. it is an indirect prompt-injection surface. Mitigations present: 500-char cap per entry, `</user-memory>` stripping, 60-entry injection cap. Not present: poisoning detection, `kind` allowlists, human confirmation on write.
- A multi-user host must guarantee **different `dir` values for different sessions in the same process**. The library reads no environment variables and guesses no identities, so it also cannot stop you from passing the wrong directory.

## Known ceilings (deliberate)

- `recall` is case-insensitive **substring matching**, not semantic search.
- Rolling is **count-based** eviction, not LLM consolidation; the same preference stored N times occupies N lines.
- Injection is "the latest N within a character budget", not relevance-selected (`recall` is the ranked path).

If memory quality becomes the bottleneck, the upgrade path is a consolidation pass / semantic index **on top of** `entries.jsonl`: storage shape unchanged, scope contract unchanged, host code untouched. That path is recorded in the source comment (`ponytail:`).

## Release

Published: npm [`pi-scoped-memory`](https://www.npmjs.com/package/pi-scoped-memory) `0.1.0` + GitHub [`njuptlzf/pi-scoped-memory`](https://github.com/njuptlzf/pi-scoped-memory), MIT (`Copyright (c) 2026 njuptlzf`).

What's in the tarball: `package.json` (`pi.extensions` + `keywords: ["pi-package"]`; the host-provided `@earendil-works/pi-coding-agent` and `typebox` are declared as `peerDependencies: "*"`, **not** in `dependencies` — see pi's `docs/packages.md`), `src/index.ts` (**223 lines**; the published artefact is the TypeScript source, loaded by pi's extension loader — there is no build step), the CLI wrapper `extensions/scoped-memory.ts`, and the four docs. `test/` and `tsconfig.json` live in the repository but are excluded from the tarball by `files` — to run the 10 tests, clone and `npm install && npm test` (sanitisation / corrupt-line + rolling / **concurrent cross-process appends lose nothing** / substring recall with ranking / injection line cap and character budget, no path leakage / fake-pi structure / **two directories that cannot see each other** / **two sessions on one directory see each other** / wrapper directory resolution).

Where it came from: this repository is the **single source of truth**. Its parent project, the agent-chat monorepo, imports `src/index.ts` from here (`packages/server/src/session.ts`), and the old `packages/server/src/extensions/scoped-memory.ts` was moved out with `git mv` — there is no second copy. The two host-side integration tests (storage lands under `(userId, scope)`; `agent.memory: false` registers no tools) stay in `packages/server/test/memory.test.ts`, because they assert the host contract, not this package. Original implementation commit: `c40f503`; the decision record is the S2-5 row of the project handoff doc (Chinese), under `docs/` of the agent-chat repository ([docs directory](https://github.com/njuptlzf/agent-chat/tree/main/docs)).

