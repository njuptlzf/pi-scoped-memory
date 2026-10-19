# Why not hermes: a reusable selection note

[中文](./WHY-NOT-HERMES.md) · **English**

Subjects: `pi-hermes-memory@0.9.10` ("hermes") and this repository's `scopedMemory`.

**Conclusion**: `scopedMemory` is not an extension, wrapper or adapter of hermes. It is another implementation of the same *capture → store → inject* pattern. Zero code overlap: no imports, no dependency, no shared storage — the only borrowing is one `execute` return shape (`{ content, details }`). hermes is the rich implementation of that pattern (sqlite index, semantic retrieval, LLM consolidation, multi-target routing); this extension is the **scope-safe** implementation (164 lines, only node built-ins `fs`/`path` besides `typebox`, and one directory as its entire interface).

---

## 1. Choose first: when you must use this and cannot use hermes

One branch decides everything: **can more than one identity appear in the same process?**

```
Will a single process serve >1 user/tenant?
├─ yes → hermes is out (unless you start one process per identity = a process
│         pool, which is a different cost entirely)
│        └─ and you must partition by (user, sub-scope)?
│             → scopedMemory, with the host computing dir
└─ no (single-user CLI: one person, one machine, one agent root)
         ├─ will entries grow enough to need semantic retrieval / consolidation?
         │    → use hermes, not this
         └─ you just want "remember my preferences", jsonl + substring is fine
              → either works; this one is lighter
```

### Situations that require scopedMemory

| # | Situation | Why hermes does not work |
|---|---|---|
| 1 | **Embedded multi-user service**: one Node process serves sessions for many `userId`s, per request | Process-level constant + global directories (see ① and ②): different users write into the same file. That is a privacy incident, not "slightly worse UX" |
| 2 | **Only the host knows the partition key**: tenant id, exam qualification, store, team, campaign window | hermes partitions by `cwd` basename (`src/project.ts:99-123`) and has no concept of userId/tenant. Stuffing identity into `cwd` turns the tenant key into a concatenated filename (collisions when it contains `__`) and `cwd` is put into the system prompt by pi itself |
| 3 | **Per-user erasure / export obligations** (compliance deletion, account closure, data export) | One scopedMemory directory is erased with `rm -rf`; jsonl exports and diffs cleanly. hermes' user / memory / failure entries live in the process-shared global files and sqlite — per-person deletion is either impossible or a fragile script |
| 4 | **No native dependencies allowed**; small cold start / image size | hermes needs `better-sqlite3` (native module / prebuilt binary) and spawns a subprocess for consolidation. A pure-jsonl extension has neither |
| 5 | **Memory must be auditable and reviewable like code** | Storage is a human-readable `entries.jsonl`: corrupt lines skipped, full rewrite via temp+rename. A sqlite index cannot answer "what exactly was injected into the prompt" from a diff |
| 6 | **You refuse to let the model decide where a memory belongs** | See ②: hermes' routing guidance actively points the most valuable preference memories at the global directory. This extension has no target concept, so the model cannot misfile |

### Situations where hermes is the better answer (honest list)

| Situation | Reason |
|---|---|
| Single-user coding agent (local CLI, real git repo, real project directory) | "Project" genuinely is the scope, so hermes' cwd discovery is right; semantic retrieval + consolidation + layering (user/memory/failure/project) is net gain |
| Entries in the thousands/tens of thousands, needing relevance recall | This extension's `recall` is case-insensitive substring matching and injection is "latest 60, all of them"; it degrades at scale |
| You need automatic dedup, conflict resolution, experience distillation | This extension only rolls by count (default 200, oldest dropped); the same preference stored N times takes N lines |
| Single tenant, but you want a cross-project "lessons" layer | That layer lives in hermes' global directory by design — it is a feature, not a bug |

Counter-example worth stating: **if your deployment already runs one process per user**, hermes' process-level constant is not a leak at all. The multi-tenancy reason vanishes and you should use hermes for its retrieval and consolidation quality.

---

## 2. Why "a narrow plugin wrapping hermes = multi-tenant hermes" does not hold

The leak surface is **structural. It is not in the storage pipeline, so wrapping it cannot plug it.** Four reasons:

### ① The process singleton cannot be removed

`AGENT_ROOT` is a module-level constant evaluated **at import time** in hermes' `src/paths.ts:5` (env `PI_CODING_AGENT_DIR`, else `~/.pi/agent`). In Node, a module initialises once per process — the host has **no moment between sessions** at which to swap its root. The only physical isolation is one process per user, which is exactly the process-pool option we rejected.

### ② The leak sits precisely where a wrapper reaches least: the prompt semantics layer

hermes' routing guidance in `src/constants.ts:219-229` actively **teaches the model** to choose the global directory: "user identity/preferences → `target: user`", "cross-project experience/corrections/failure lessons → `target: memory` / `failure`". And `sqliteProjectFor` in `src/memory-tool.ts:63-67` returns null for all three of those (= the shared global directory); only `project` gets a per-cwd directory. In other words, **the most valuable memory types in hermes' design are exactly the ones written outside any tenant directory**, and there is no config switch to lock writes to `project`.

Can a narrow plugin rewrite the tool parameters or prompt fragments another extension registered? **There is no such mechanism.** Verified against the pi SDK: `replaceable: true` only makes a *named inline* extension get skipped on name collision, and the replaceable ones the docs list are the CLI's built-in codemode / tool search / MCP extensions (`docs/sdk.md:112`). It is not a capability to override another extension's prompt content.

### ③ An intercepting adapter ends up self-cancelling

pi's `tool_call` genuinely can mutate input or block execution (`docs/extensions.md:106`: "can mutate input or block execution"), so "block non-project writes" is technically doable. But blocking `user` / `memory` / `failure` means amputating most of hermes, and what remains is "points stored per directory + a capture/inject loop" — **which is this extension**, except carrying hermes itself, its dependency tree (the probe installed `better-sqlite3@^13` for it, via prebuilt binaries), and the process-level constant that stays suspended forever: one missed interception rule is a leak again.

### ④ Forking is not worth it

Turning scope into a hermes concept touches ~60 source files (the core of it: `AGENT_ROOT` from module constant to constructor parameter, target routing replaced by a host-supplied partition key). The measured cost far exceeds a 164-line rewrite.

---

## 3. When it is worth looking back at hermes

Not "add an adapter" — **change the direction of evolution**. Trigger:

- Entries grow past what substring `recall` handles, or the 60-entry injection cap gets contradicted by real hit rates.

Two routes, in priority order:

1. **Add retrieval on top of this extension's storage shape** (preferred): a semantic index / consolidation pass over `entries.jsonl`. File shape and scope contract unchanged, tenant boundary intact, host code untouched.
2. **Actually need hermes' heavy capabilities**: the correct move is to fork it into **per-scope instances** (`AGENT_ROOT` becoming a constructor parameter — i.e. that 60-file job), not to wrap another layer around it.

## 4. Citations and provenance

hermes line numbers come from a source probe of `pi-hermes-memory@0.9.10` done before the decision; that dependency has since been uninstalled, so the numbers cannot be re-verified on this machine. The record of the probe lives in the agent-chat repository: the S2-5 row of `docs/软考助手 agent-chat：项目背景与开发交接文档.md` and commit `c40f503`.

Four pi-side claims were re-checked locally against `@earendil-works/pi-coding-agent@1.2.0`: the scope of `replaceable` (`docs/sdk.md:112`), `tool_call` mutating/blocking (`docs/extensions.md:106`), extensions requiring `export default function (pi: ExtensionAPI)` (`docs/extensions.md:15`), and `dist/index.d.ts` not exporting `Type` (so tool schemas must `import { Type } from "typebox"` themselves — declared as `peerDependencies: "*"` per `docs/packages.md:80-88`, never bundled).

To reproduce hermes' behaviour in an issue, you must first `npm i pi-hermes-memory@0.9.10`.

## 5. One sentence

**hermes + a narrow plugin ≠ multi-tenant hermes**: the leaks live in the process constant and the prompt routing, two places an adapter cannot reach. `scopedMemory` redraws the same pattern inside the tenant boundary instead of patching hermes — paying explicitly for hermes' retrieval and consolidation quality, and gaining a plugin that loads safely in a multi-user process and publishes as a package with no business knowledge in it.
