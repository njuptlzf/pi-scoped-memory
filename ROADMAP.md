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
| Keyword retrieval | SQLite FTS5 index | case-insensitive substring scoring (`recallEntries`) | High once a scope passes ~hundreds of entries |
| Injection policy | relevance-driven | last 60 lines / 4000 chars, recency-only | Medium — old-but-relevant points silently invisible |
| Consolidation | auto-consolidation pass | none (compaction only trims count) | Medium — duplicate/stale facts accumulate |
| Memory tiers | user / memory / failure / project targets | 4 `kind` labels, retention treats them alike | Low — tiers are a tenant leak in hermes; `kind` + host-side dirs cover most of it |
| Session search | searches past conversations | out of scope by design (host owns transcripts) | None — deliberate non-goal |
| Secret scanning | built-in | host-side (agent-chat filters in its autoCapture) | None — host responsibility by contract |

## Items

### R1 — Keyword retrieval upgrade: FTS over the scope's own index

`recall` today is substring matching; it stops being adequate at "hundreds of
points in one scope". Add an FTS index (SQLite via `node:sqlite` — FTS5
availability in the bundled build to be verified before design lock) stored as
`<dir>/index.sqlite`, rebuilt from `entries.jsonl` on first touch, deleted
without harm at any time.

- **Trigger**: real recall-miss reports from a host, or a scope exceeding ~500
  entries.
- **Constraint check**: index is per-scope (constraint 2/3), no native dep
  (constraint 4), no behavior change without the index present.
- **Acceptance**: recall@5 on a 1000-entry synthetic scope strictly better than
  substring scoring; a deleted index self-rebuilds on next recall.

### R2 — Hybrid recall: FTS + host-injected embeddings, rank-fused

Two indexes inside the scope dir, one query path. R1's FTS index and an
optional vector cache (embeddings of entry texts, computed via a host-injected
`embed?: (texts: string[]) => Promise<number[][]>`) are queried independently;
results are fused with Reciprocal Rank Fusion (`score = Σ 1/(k + rank_i)`,
k = 60) into a single ranked list. Fusion is chosen over score addition because
BM25 and cosine scores are not on a common scale. No provider SDK, no key
handling inside the plugin (constraint 5). Reference shape: Mem0-style fact
retrieval, minus the managed service.

- **Trigger**: R1 shipped and keyword recall demonstrably misses paraphrases.
- **Degradation ladder** (each rung fully functional): both indexes → FTS only
  → substring scoring. Without `embed`, everything behaves exactly as after
  R1; a failed or timed-out embedding call falls back to FTS-only for that
  query — never blocks or errors a session.
- **Cache invalidation**: embedding cache is keyed by entry text hash;
  compaction and consolidation drop stale vectors alongside the entries they
  served. Cache lives in-scope and rebuilds by re-calling `embed`
  (constraint 2).
- **Acceptance**: paraphrase pairs that FTS alone misses are recalled via the
  vector leg; removing the callback never breaks a session; a query returns
  within 50 ms P95 at 1000 entries with warm caches (local benchmark, no
  network).

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
