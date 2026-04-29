# `@anvil/memory-core`

Long-term memory layer for Anvil — five-type taxonomy
(`working` / `episodic` / `semantic` / `procedural` / `profile`),
bi-temporal facts, code-fact drift detection, hybrid retrieval (BM25 +
graph + Personalized PageRank), sleeptime ratification, reflection on
PR/CI completion, and PR-as-episode primitives.

> **Status:** All 14 phases shipped. See
> [`MEMORY-CORE-ADR.md`](../../MEMORY-CORE-ADR.md) for the per-phase
> commit log + deviations.

## What's in the package

```
src/
  types.ts                     ADR §7 canonical schemas (frozen)
  storage/                     JSONL canonical + SQLite hot index (FTS5 BM25)
  namespace/                   LangMem-style {scope, projectId?, repoId?, userId?} tuples
  drift/                       Code-fact structural-hash drift detection (Phase 6)
  scrubber/                    PII/secret regex scrubber (Phase 7) — wired into add()
  retrieve/                    BM25 + graph + RRF fusion + Personalized PageRank
  sleeptime/                   Proposal queue + dedupe + ratify + consolidator
  reflect/                     Reflection-on-completion → proposals
  episode/                     PR-as-episode (kind: 'episodic')
  inspector/                   Dashboard / cli read primitive
  migrate/                     Legacy importer (`~/.anvil/memory/<project>/memories.jsonl`)
  legacy/                      Hoisted from cli/src/memory/ — stays for backwards compat
```

## Quick start

```ts
import {
  HybridMemoryStore,
  ProposalQueue,
  consolidate,
  hybridSearch,
  importLegacyMemories,
} from '@anvil/memory-core';

const store = HybridMemoryStore.open({
  jsonlPath: `${process.env.HOME}/.anvil/memory/v2.jsonl`,
  sqlitePath: `${process.env.HOME}/.anvil/memory/v2.sqlite`,
});

// Hybrid retrieval (BM25 + graph 1-hop expansion + RRF fusion)
const hits = await hybridSearch(store, 'kafka rebalance bug', {
  namespace: { scope: 'project', projectId: 'demo' },
  limit: 10,
});

// Sleeptime ratification of the proposal queue
const queue = new ProposalQueue(store.sqlite);
const result = await consolidate(store, queue, {
  scope: 'project',
  projectId: 'demo',
});
console.log(result); // { scanned, ratified, merged, rejected, superseded }

// One-shot legacy migration
importLegacyMemories(`${process.env.HOME}/.anvil/memory`, store);
```

## The five memory types

| Kind         | When to use                                | Persistence              |
|--------------|--------------------------------------------|--------------------------|
| `working`    | In-context only (scratchpad)               | **never** — runtime only |
| `episodic`   | Run events, PR records, observed traces    | durable                  |
| `semantic`   | Facts: fix-pattern / success / approach / flaky-test / performance / manual (carries `subtype`) | durable |
| `procedural` | How-to rules; sleeptime PROPOSES SKILL.md  | durable                  |
| `profile`    | User preferences inferred from interaction | durable                  |

## Storage layout

```
~/.anvil/memory/
  global/                                 # {scope: 'global'}
  user/<userId>/                          # {scope: 'user', userId}
  project/<projectId>/                    # {scope: 'project', projectId}
  repo/<projectId>/<repoId>/              # {scope: 'repo', projectId, repoId}
  <legacy-project>/                       # legacy layout — still loadable
```

Legacy directories (no scope prefix) are interpreted as
`{scope: 'project', projectId: <dir>}` so existing data keeps loading
without a hard cutover. Use `importLegacyMemories` to relocate into the
v2 layout.

## Bi-temporal model

Memories are **never hard-deleted by normal flows**. TTL expiry → soft
delete (sets `bitemporal.invalidAt`); manual `invalidate(id, ...)` does
the same. Default queries hide invalidated rows; pass
`includeInvalidated: true` (or an explicit `validAt`) to peer back at
historical state.

`hardDeleteInvalidatedOlderThan(cutoff)` reclaims rows past the retention
window (default 365 days per ADR §M8).

## Sleeptime architecture

```
auto-learner ─────► proposal queue ─────► consolidator ─────► durable store
   (hot path)         (Phase 10)            (sleeptime)         (HybridStore)
                          │                     │
                          │                     ├── dedupe (hash + BM25 NN)
                          │                     ├── decideFn (LLM or default)
                          │                     ├── ratify {add, merge-into,
                          │                     │           reject, supersede}
                          │                     └── reflect → SKILL.md proposals
                          │
                          └── reflectOnRun (Phase 11) on PR/CI complete
```

Auto-learners on the hot path **propose**; the consolidator **ratifies**.
This is the architectural fix for mem0's "every event becomes a memory"
failure mode.

## env vars

| Name                       | Default | Effect |
|----------------------------|---------|--------|
| `ANVIL_MEMORY_SCRUB`       | `1`     | `0`/`off`/`false` disables scrubber (unsafe). `llm` reserves a slot for the optional LLM classifier (regex-only today). |

## Migration guide

```sh
# 1. Back up first (importer also writes .pre-migration.bak per file)
cp -r ~/.anvil/memory ~/.anvil/memory.pre-migration

# 2. Dry run
node -e "
  import('@anvil/memory-core').then(({HybridMemoryStore, importLegacyMemories}) => {
    const store = HybridMemoryStore.open({
      jsonlPath: '$HOME/.anvil/memory/v2.jsonl',
      sqlitePath: '$HOME/.anvil/memory/v2.sqlite',
    });
    console.log(importLegacyMemories('$HOME/.anvil/memory', store, { dryRun: true }));
  });
"

# 3. Real run
# Drop dryRun: true. The importer is idempotent — id collisions upsert.
```

The importer routes every entry through the Phase 7 scrubber, so any
inadvertent secrets in legacy data get redacted (or hard-rejected for
credential-class matches) at import time.

## Lock-in surface

- **`better-sqlite3`** (MIT) — sync, single-file, native bindings with
  prebuilds for every Node-supported platform. Replacement cost: rewrite
  the storage adapter (~200 LOC). Acceptable.
- **`ulid`** (MIT) — ID generation; sortable lexicographically by creation
  time, URL-safe, 26 chars.
- **LanceDB via `@anvil/knowledge-core`** — already in tree; no new
  commitment. The vector retrieval module (`retrieve/vector.ts`) is a
  forward-compat stub; sleeptime will populate embeddings in a later
  follow-up.
- **No graph DB.** Adjacency tables in SQLite + Personalized PageRank
  computed in TS over JS arrays. ~140 LOC.
- **No mem0, Letta, Zep, LangMem, or Cognee SDKs.** Patterns stolen,
  code hand-rolled.
