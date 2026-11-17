# Roadmap

Capability plan for `pi-scoped-memory`. Items are listed by capability, not by date —
each carries a trigger ("when this hurts") and the constraints it must not violate.

The benchmark used throughout is `pi-hermes-memory@0.9.10` (see
[WHY-NOT-HERMES.md](./WHY-NOT-HERMES.md)): it is the "rich" implementation of the
same capture → store → inject pattern, and the gaps below are exactly the quality
this plugin deliberately traded away for scope safety. Broader industry memory
frameworks (Mem0, Zep, Letta) were surveyed as capability references; none is a
drop-in replacement here because none satisfies the contract below — they are
consulted for feature shape, not for code.

## Non-negotiable constraints (every item)

1. **Scope contract unchanged.** The plugin knows one directory; the host owns
   identity. No process-global state, no `cwd`/env discovery, no tenant logic
   inside the plugin. This is the reason the plugin exists (WHY-NOT-HERMES §二).
2. **`entries.jsonl` stays the source of truth.** Every derived artifact
   (index, embedding cache) must live *inside the scope directory*, be
   rebuildable from the jsonl alone, and be safe to delete at any time.
3. **Per-scope erasure and export remain trivial.** One `rm -rf` = one scope
   fully gone. No shared-on-disk structure across scopes, ever.
4. **No native modules in the required path.** Node built-ins first
   (`node:sqlite` is available on Node ≥ 22.13); anything heavier is optional
   and host-injected.
5. **The plugin owns no LLM and no API keys.** Any semantic/consolidation
   capability receives a host-provided callback; without one, the plugin
   degrades to today's behavior, silently.
6. **Append-only remains the concurrency story.** One `O_APPEND` write per
   mutation, tombstones for deletes, lazy compaction — no read-modify-write
   over the whole file on the hot path.

## Gap table (vs pi-hermes-memory@0.9.10, probed; see WHY-NOT-HERMES §四)

| Capability | hermes | this plugin | Gap severity for a web multi-user host |
| --- | --- | --- | --- |
| Keyword retrieval | SQLite FTS5 index | case-insensitive substring scoring (`recallEntries`) | High once a scope passes ~hundreds of entries; plus a CJK pitfall found by probe — see R1 |
| Injection policy | relevance-driven | last 60 lines / 4000 chars, recency-only | Medium — old-but-relevant points silently invisible |
| Consolidation | auto-consolidation pass | none (compaction only trims count) | Medium — duplicate/stale facts accumulate |
| Memory tiers | user / memory / failure / project targets | 4 `kind` labels, retention treats them alike | Low — tiers are a tenant leak in hermes; `kind` + host-side dirs cover most of it |
| Session search | searches past conversations | out of scope by design (host owns transcripts) | None — deliberate non-goal |
| Secret scanning | built-in | host-side (agent-chat filters in its autoCapture) | None — host responsibility by contract |

## Items

### R1 — Keyword retrieval upgrade: BM25 over the scope's own index

`recall` today is substring matching; it stops being adequate at "hundreds of
points in one scope".

**Probed findings (2026-11-17, Node 22.22.2) that fixed the design:**

- `node:sqlite` FTS5 and the `trigram` tokenizer are available in the bundled
  build — but the default `unicode61` tokenizer **cannot match Chinese at all**
  (a CJK run becomes one token; "登录" finds nothing), and `trigram` cannot
  serve 2-char CJK queries (needs ≥3 chars). CJK must go through a real
  segmenter, not SQLite tokenizers.
- Node's built-in `Intl.Segmenter('zh', { granularity: 'word' })` segments
  Chinese memory-style text correctly (用户/偏好/深色/主题, `ERR_AUTH_403`
  kept whole). No external segmentation package needed.
- ICU data completeness in minimal images is verified, not assumed: a CI probe
  (`.github/workflows/icu-probe.yml`, manual dispatch) ran the same
  segmentation check inside `node:22-slim`, `node:22-alpine`, `node:24-slim`
  and `node:24-alpine` — all resolve the segmenter locale to `zh` (small-icu
  would fall back to `en`), bundle ICU 78.3, and produce identical correct
  tokens, including 2-char words (登录 / 认证).

**Design**: index entries with [MiniSearch](https://github.com/lucaong/minisearch)
(`^7.2.0`, zero dependencies, BM25 scoring, `toJSON()`/`loadJSON()`
serialization) with `tokenize` wired to `Intl.Segmenter`. The serialized index
is stored as `<dir>/index.minisearch.json`, rebuilt from `entries.jsonl` on
first touch, deleted without harm at any time. `node:sqlite` FTS5 (trigram)
remains a fallback option for ASCII-heavy scopes, not the primary path.

- **Trigger**: real recall-miss reports from a host, or a scope exceeding ~500
  entries.
- **Constraint check**: index is per-scope (constraint 2/3), MiniSearch is pure
  JS with zero runtime deps (constraint 4), no behavior change without the
  index present.
- **Acceptance**: recall@5 on a 1000-entry synthetic scope (Chinese and mixed
  zh/en entries) strictly better than substring scoring; 2-char CJK queries
  ("登录") hit; a deleted index self-rebuilds on next recall.
- **Decision (2026-11-17, host confirmed)**: cold-start full rebuild latency at
  ~1000 entries is accepted as-is for R1 — no gating benchmark on it. Optimizing
  the rebuild path is deferred to backlog item B1.

### R2 — Hybrid recall: FTS + host-injected embeddings, rank-fused

Two indexes inside the scope dir, one query path. R1's BM25 index (MiniSearch)
and an optional vector cache (embeddings of entry texts, computed via a
host-injected `embed?: (texts: string[]) => Promise<number[][]>`) are queried
independently; results are fused with Reciprocal Rank Fusion
(`score = Σ 1/(k + rank_i)`, k = 60) into a single ranked list. Fusion is
chosen over score addition because BM25 and cosine scores are not on a common
scale. No provider SDK, no key handling inside the plugin (constraint 5).
Reference shape: Mem0-style fact retrieval, minus the managed service.

- **Trigger**: R1 shipped and keyword recall demonstrably misses paraphrases.
- **Degradation ladder** (each rung fully functional): hybrid (both legs) →
  BM25 only → substring scoring. Without `embed`, everything behaves exactly
  as after R1; a failed or timed-out embedding call falls back to BM25-only
  for that query — never blocks or errors a session.
- **Cache invalidation**: embedding cache is keyed by entry text hash;
  compaction and consolidation drop stale vectors alongside the entries they
  served. Cache lives in-scope and rebuilds by re-calling `embed`
  (constraint 2).
- **Acceptance**: paraphrase pairs that BM25 alone misses are recalled via the
  vector leg; removing the callback never breaks a session; a query returns
  within 50 ms P95 at 1000 entries with warm caches (local benchmark, no
  network).

## Backlog (low priority)

### B1 — Cold-start index rebuild optimization

R1 rebuilds the MiniSearch index from `entries.jsonl` on first touch after a
restart. At ~1000 entries the host accepted the full-rebuild latency as-is
(decision recorded under R1), so this item is explicitly **not** on the
critical path. Options when it ever matters, in order of cost:

1. Load the persisted `index.minisearch.json` via `MiniSearch.loadJSON()`
   instead of re-tokenizing every entry; validate it against the jsonl's
   content hash and fall back to full rebuild on mismatch.
2. Incremental: index only entries appended since the last index write
   (jsonl line offset persisted alongside the index).

- **Trigger**: any host reporting perceptible first-query latency after
  restart, or a scope growing past ~5000 entries.
- **Constraint check**: both options keep the jsonl as source of truth and the
  index rebuildable/deletable (constraint 2); no new dependencies.

## Sourcing: import vs build

What each item actually needs from the ecosystem, probed/verified
2026-11-17. The external import surface is deliberately **one package**;
everything else is Node built-ins or small glue that must stay in-repo to
hold the constraints.

| Item | Source | Why |
| --- | --- | --- |
| R1 BM25 index | **import** `minisearch@^7.2.0` (zero runtime deps, BM25, `toJSON`/`loadJSON`) | Reimplementing BM25 + prefix/field search is exactly the wheel not to rebuild |
| R1 CJK tokenization | Node built-in `Intl.Segmenter` | Probed correct for zh; an external segmenter package would be a second import for no gain |
| R1 fallback | Node built-in `node:sqlite` (FTS5 + trigram) | Already in the runtime; ASCII-heavy scopes only — see R1 probed findings |
| R2 vector leg | **build** brute-force cosine (~20 lines) | Scope scale is ≤ thousands of entries; 1000 × 1536-dim cosine is low-single-digit ms in JS — ANN libraries (HNSW etc.) are native modules or oversized for this scale, violating constraint 4 |
| R2 RRF fusion | **build** (~15 lines) | One formula; a package would out-weigh the code |
| R3 injection policy | **build** (~50 lines) | Policy, not mechanism — no package expresses it |
| R4 consolidation | **build** (~100 lines, host-injected LLM callback) | mem0/hermes consolidation is coupled to their own storage/identity — importing means importing the constraints we rejected |
| R5 per-kind retention | **build** (~40 lines compaction policy) | Same reasoning |
| Embeddings (host side) | host's choice of SDK | Stays outside the plugin by constraint 5; agent-chat already has a model config plane to route it |

Rejected imports, for the record: `better-sqlite3` (native, constraint 4),
`@lancedb/lancedb` (native core; its built-in hybrid search is attractive but
the packaging violates the no-native-deps rule — re-evaluate only if scope
scale ever outgrows brute-force cosine), `pi-hermes-memory` (WHY-NOT-HERMES).

Net: **R1–R5 need exactly one new dependency** (`minisearch`) plus roughly
200–300 lines of in-repo glue and policy code.

### R3 — Injection policy: relevance + kind weighting, not recency-only

The injected snapshot is "last 60 lines within 4000 chars" — pure recency.
Select instead by a blended score (recency × relevance-to-session-start × kind
weight), still frozen per session for prompt-cache stability, still bounded by
the char budget.

- **Trigger**: host reports relevant old memories not appearing in context.
- **Constraint check**: pure read-side change; storage shape untouched.
- **Acceptance**: pinned/preference kinds surface over old noise; snapshot
  stays byte-stable within a session.

### R4 — Consolidation pass: distill stale points (host-invoked)

Per-scope growth is bounded only by `maxEntries`; compaction drops lines but
never merges facts. Add an explicit `consolidate()` export the host may call
between sessions: it batches old entries, passes them through a host-provided
LLM callback (constraint 5), and writes back as merged points with tombstones
for the consumed ones — append-only, auditable in the jsonl.

- **Trigger**: a scope where dedup/refresh matters (long-lived user accounts).
- **Constraint check**: host-invoked only, never automatic inside the plugin;
  every merge is reconstructible from the jsonl (constraint 2).
- **Acceptance**: a 300-entry scope collapses to ~50 without losing the 20
  most recent or any pinned preference; audit trail shows original + merged.

### R5 — Per-kind retention: caps, TTL, pinning

`kind` is a free label with no retention semantics. Allow per-kind
configuration at factory time (cap / TTL / pin), enforced at compaction.

- **Trigger**: a host needs "corrections live forever, facts expire".
- **Constraint check**: config comes from the host factory call — still no
   tenant logic in the plugin.
- **Acceptance**: expired kinds vanish from injection and recall; pinned
  entries survive compaction.

## Explicit non-goals

- Tenant/user/project management inside the plugin (the founding decision).
- Session transcript search (the host owns transcripts; agent-chat keeps them
  in SQLite).
- A database that spans scopes or survives scope deletion.
- Becoming or wrapping hermes in-process (WHY-NOT-HERMES §二; the only honest
  fork route is per-scope instantiation — a rewrite, not a wrapper, and only
  worth it if R1–R4 prove insufficient).

## Sources

- `pi-hermes-memory@0.9.10` — probed locally; findings and line references in
  [WHY-NOT-HERMES.md](./WHY-NOT-HERMES.md).
- Industry capability references (feature shape only, not integrable here):
  Mem0 (per-user profiles, multi-tenant chatbots), Zep/Graphiti (temporal
  knowledge graph), Letta (OS-style memory tiers). Claims about their current
  versions/stars are not pinned here on purpose — verify before citing.
