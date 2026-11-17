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
| Write-side conflict resolution | none beyond capture policies | exact-text dedup only | **High vs mem0** — mem0 resolves each candidate fact against similar existing memories at write time (ADD/UPDATE/DELETE/NOOP per mem0's own docs); this plugin accumulates contradictions and semantic duplicates verbatim until compaction drops by count. Mem0's docs name this the "stacked-contradictions failure" — long-lived user scopes hit it first. See R6 |
| Temporal validity | none (fact superseded = silently duplicated) | only a single `at` timestamp per entry | Medium vs Zep/Graphiti (bi-temporal KG) and mem0 (fact invalidation) — superseded facts never get marked invalid; related to R6 |
| Retrieval-quality regression suite | 732 tests, policy benchmarks | functional tests only — no standing recall-quality benchmark | Medium — R1/R2 acceptance is one-off synthetic; without a committed eval set, quality regressions land silently. See R7 |
| Memory-op observability | policy/token stats | no per-scope counters (recall calls, hit rate, injection size) | Medium-low — hosts cannot see whether memory is used or worth its token budget. See R8 |
| Procedural layer (failure → lessons) | procedural skills | `kind: failure` is a bare label | Low — see backlog B2 |
| Memory tiers | user / memory / failure / project targets | 4 `kind` labels, retention treats them alike | Low — tiers are a tenant leak in hermes; `kind` + host-side dirs cover most of it |
| Session search | searches past conversations | out of scope by design (host owns transcripts) | None — deliberate non-goal |
| Secret scanning | built-in | host-side (agent-chat filters in its autoCapture) | None — host responsibility by contract |
| Graph-structured memory | none | none | None today; Zep/Graphiti's temporal KG is a different product shape — see non-goals |

## Items

### F0 — Decision gate: fork-spike on pi-hermes-memory@0.11.0 (R1 gate)

Re-probe (2026-11-17) shrank the fork estimate from WHY-NOT-HERMES §④'s
"~60 files" to a concrete, small surface (see the addendum there). Before
starting R1, run a time-boxed spike (1–2 days) to decide fork vs in-repo
roadmap with data:

1. **Per-session factory**: wrap the extension entry into an option-taking
   factory (`createScopedHermesMemory({ dir })`, scopedMemory pattern). Entry
   is already a per-run factory with `config.memoryDir` honored by
   MemoryStore; remaining: thread `dir` through ~5–8 call sites that bypass
   config (`skill-store.ts`, `session-search-tool.ts`, `index-sessions.ts`,
   auto-consolidation locks) and make the 2 import-time constants
   (`SESSIONS_DIR`, `DEFAULT_SESSIONS_DIR`) lazy.
2. **Dual-root split**: `AGENT_ROOT` is both memory-storage root and pi
   runtime module-discovery root (`pi-child-process.ts:239`). Split storage
   root (per-scope) from runtime root (global) — do not scope the latter.
3. **Routing guidance**: rewrite `buildMemoryTargetRoutingGuidance()` to
   scope-relative wording.
4. **Concurrency safety**: no process-global `setAgentRoot` shortcut —
   interleaved sessions would cross directories. Param threading or ALS only.
5. *(optional, bigger)* Swap `better-sqlite3` → `node:sqlite` in
   `store/sqlite-native.ts` (shim precedent exists); kills the native dep.

**Sync discipline, calibrated against `njuptlzf/mcp-adapter` (2026-11-17).**
Its discipline is three artifacts, not one README claim: (a) `MAPPING.md` — a
surface → upstream call-site **evidence** table; (b) `scripts/upstream-divergence.ts`
(`npm run upstream:check`) — diffs fork ↔ `upstream/main` and classifies every
file into *registered / diverged-but-not-registered / stale*, exiting `1` on
stale; (c) a registry file (`skills/upstream-merge/references/special-cases.md`)
that the check reads, plus branch policy (`upstream-merge/<version>` PRs,
`.githooks/pre-push` + `no-direct-main-push.yml` blocking direct pushes).

The analogy does not transfer unmodified — three deltas to carry over:

- **D1 — the invariant is weaker, so enforcement must be blocking.** "Engine
  untouched" is *structural* for mcp-adapter: the engine runs against a type
  boundary (`UniversalHostSurface` ↔ `ExtensionAPI`), so a violation fails to
  compile. A hermes fork mutates 10 upstream files instead; nothing fails when
  an 11th edit slips in. Compensate with an allowlist CI gate that exits `1`.
  Note the trap: mcp-adapter's own `check-pi-coupling.yml` is **advisory only**
  (every path ends in `exit 0`) — it reports and never stops a merge. Do not
  copy that half.
- **D2 — measure conflict surface, not changed files.** Its retrospective
  (`docs/upstream-merge-retrospective.md`) records the first real merge: 11
  conflict files, ~1300 conflict lines, 768 lines of coupling re-introduced,
  root-caused to *large-function aggregation* — `index.ts` held a 343-line
  function that conflicted wholesale ("same-function-body" class, the hardest
  to resolve). Translating to hermes: "10 files" is not the merge cost; the
  question is which of our hunks land inside regions upstream also edits.
  Leaving `store/memory-store.ts` (1309 lines) untouched is exactly right —
  zero hunks there, so upstream edits to it merge cleanly. Wrapping `index.ts`
  from outside the existing function is the safe shape; editing its body is the
  risky one.
- **D3 — stale detection is the half that pays.** A registry that never expires
  decays into a lie, and hermes@0.9.10's "~60 files / constants can't be
  routed" estimate — disproved by 0.11.0 — is precisely a stale entry. `stale`
  means "our divergence no longer exists because upstream absorbed it"; that
  signal is the trigger to re-probe upstream, so seed the registry from the
  current 10 files / 27 `AGENT_ROOT` references and re-run the check per
  release.

**Spike deliverables**: real diff size *and* conflict-hunk count, hermes'
test-suite pass rate at v0.11.0, the fork-delta ↔ upstream-surface mapping doc
with an evidence column per row, plus the divergence registry and its
`upstream:check` (blocking on stale). Version tag tracks upstream, e.g.
`hermes-0.11.0-scoped.1`.

**Decision rule**: if the spike lands at ≤ ~15 changed files with tests green,
no hunk inside a function upstream actively edits, and a merge-drill against
the next upstream release reads as routine, the fork replaces R1/R2/R4
(retrieval, hybrid, consolidation arrive with hermes) and the roadmap continues
with R3/R5/R6/R7/R8 layered onto it. Otherwise R1 starts as planned and the
fork waits for its documented trigger.

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

- **Implementation note (do not forget)**: create one `Intl.Segmenter`
  instance per locale and reuse it (module-level or factory-level cache) —
  never construct a new Segmenter per entry or per query. Segmenter
  construction is a costly ICU operation and would dominate tokenize time on
  bulk index rebuilds. Same for the MiniSearch instance: one per scope dir,
  lazily created on first index touch.

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

### B2 — Procedural layer: failure points become lessons

hermes turns remembered failures into procedural skills; here `kind: failure`
is a bare label. Low priority because the *effect* is achievable host-side
(agent-chat's autoCapture can distill failure clusters into guidance entries).
If the plugin ever wants it in-scope: a host-invoked pass that groups
`failure` entries by BM25 similarity and writes back one "lesson" entry with
tombstones for the consumed ones — same shape as R4's consolidation, restricted
to one kind.

- **Trigger**: a host asking for failure-driven guidance that host-side
  distillation cannot express.

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

### R6 — Write-side conflict resolution: semantic dedup and supersession

The read side is covered by R1–R3; the **write side is where the plugin is
most behind mem0**. Today a `remember` call appends unless the text matches an
existing entry case-insensitively — paraphrases duplicate, and a contradictory
new fact ("用户现在偏好浅色主题" after "偏好深色主题") coexists with the old one
until count-based compaction silently drops one of them. mem0's documented
design resolves this at **write time**: each candidate fact is compared against
semantically similar existing memories and one of four operations is chosen —
ADD / UPDATE / DELETE / NOOP (see Sources; their docs call the un-resolved
alternative the "stacked-contradictions failure").

**Design**: an optional host-injected `review?: (candidate, similar) => …`
callback, mirroring R2's `embed` pattern (constraint 5 — no LLM in the
plugin). Semantically similar neighbors come from the R2 vector cache when
available (fall back to BM25 top-k). The default without `review` stays
exactly today's behavior. Superseded entries get a tombstone that carries
`invalidAt` + the replacing text — append-only, so constraint 6 holds, and the
supersession chain stays reconstructible from the jsonl (constraint 2). This
gives Zep-style temporal validity (valid_at / invalid_at) in the lightweight
jsonl shape.

- **Trigger**: R2 shipped (needs the similarity source), or a real
  contradiction/duplicate complaint from a host.
- **Constraint check**: host-provided review callback only; tombstones keep
  the append-only model; all state in-scope.
- **Acceptance**: a contradiction pair written in sequence recalls only the
  surviving fact, with the superseded one discoverable via `invalidAt` in the
  jsonl; paraphrase duplicates collapse; without `review`, behavior is
  byte-identical to R5-era behavior.

### R7 — Standing retrieval-quality benchmark (regression suite)

R1/R2 acceptance is a one-off synthetic check. mem0 maintains public memory
benchmarks (LOCOMO) and hermes ships 732 tests; this repo has no committed
recall-quality eval set, so a tokenizer change or a scoring tweak can silently
regress quality. Add `eval/` in-repo: a fixed corpus of ≥20 synthetic scopes
covering zh / en / mixed entries, paraphrase pairs, contradiction pairs,
2-char CJK queries, error-code lookups, and adversarial entries (prompt-injection
text inside a memory point), with a scoring script reporting recall@5 / MRR and
a pass line. Run it in CI on every PR that touches recall paths.

- **Trigger**: R1 implementation begins (the suite is its acceptance harness).
- **Constraint check**: eval corpus is test material, not runtime state —
  lives in the repo, not in scope dirs.
- **Acceptance**: `npm run eval:recall` prints a recall@5 / MRR table per
  category; CI fails below the pass line.

### R8 — Per-scope memory-op observability

No host can currently answer "is memory being used, and is it worth its token
budget?" — recall call counts, hit rate, injection size are all invisible.
Add an opt-in `stats()` export returning per-scope counters (remember/recall/
forget calls, recall hit rate, last injection char/token estimate, index
freshness), written as a counter line in the scope dir (append-only, one
aggregation per N ops — no cross-scope file). Hosts like agent-chat can route
it into their audit plane.

- **Trigger**: any host instrumentation request (agent-chat audit plane is the
  first candidate).
- **Constraint check**: counters live in-scope, never shared (constraint 3);
  disabled by default.
- **Acceptance**: a scripted 100-op session yields counters matching the op
  log; `stats()` on a scope with stats disabled returns a noop shape, not an
  error.

## Explicit non-goals

- Tenant/user/project management inside the plugin (the founding decision).
- Session transcript search (the host owns transcripts; agent-chat keeps them
  in SQLite).
- A database that spans scopes or survives scope deletion.
- Graph-structured / entity-relation memory (Zep-Graphiti shape): no trigger
  today. Point memory with R6 supersession covers the failure modes a graph
  would solve at this scale; revisit only if hosts report relational queries
  ("everything linked to project X") that recall cannot serve.
- Becoming or wrapping hermes in-process (WHY-NOT-HERMES §二; the only honest
  fork route is per-scope instantiation — a rewrite, not a wrapper, and only
  worth it if R1–R4 prove insufficient).

## Sources

- `pi-hermes-memory@0.9.10` — probed locally; findings and line references in
  [WHY-NOT-HERMES.md](./WHY-NOT-HERMES.md).
- mem0 write-side design (ADD / UPDATE / DELETE / NOOP, write-time conflict
  resolution, "stacked-contradictions failure" terminology) — from mem0's own
  documentation (mem0.ai library: memory eviction and forgetting in AI agents;
  docs.mem0.ai memory evaluation), verified 2026-11-17.
- Industry capability references (feature shape only, not integrable here):
  Mem0 (per-user profiles, multi-tenant chatbots), Zep/Graphiti (temporal
  knowledge graph), Letta (OS-style memory tiers). Claims about their current
  versions/stars are not pinned here on purpose — verify before citing.
