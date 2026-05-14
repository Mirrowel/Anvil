# @anvil/knowledge-core

**Your codebase, retrievable.**

A code-aware knowledge stack — AST-level chunking, hybrid retrieval,
project graphs, and cross-repo edge detection. Built so agents see
the *whole* codebase, not just the file you happened to open.

---

## The problem with grep + embeddings

Code search works one of two ways: lexical (grep, fast, dumb) or
embedding-based (vector DB, slow on edits, blind to structure). Both
miss the same thing: code has *graph* structure. A function isn't
just a chunk of text — it imports things, gets called by things,
implements things, lives in a package, talks to other repos.

**knowledge-core treats the codebase like a graph and a corpus at
the same time.** Tree-sitter parses every supported language into
AST chunks. A vector store + BM25 + a project graph all answer the
same query, fused into one ranked list. The retriever knows when
you're asking about an identifier vs an error code vs a natural-
language question and weights the signals accordingly.

```ts
import { KnowledgeIndexer, getRetriever } from '@anvil/knowledge-core';

// Index once — incremental thereafter.
const indexer = new KnowledgeIndexer({ project: 'space-tourism' });
await indexer.indexProject();

// Retrieve — vector + BM25 + 1-hop graph + cross-encoder rerank.
const retriever = await getRetriever('space-tourism');
const result = await retriever.retrieve(
  'where do we validate booking seat tiers?',
);

console.log(result.chunks.length, 'chunks');     // ranked, deduped
console.log(result.graphContext);                // related symbols
console.log(result.totalTokens);                 // budgeted
```

---

## What you get

### AST-aware chunking
`tree-sitter` WASM parses TypeScript, JavaScript, TSX, Go, Python,
Rust, Java, and PHP into proper function / class / method
boundaries. No more chunks that cut a function in half. Regex
fallback for languages without a grammar so nothing is unindexed.

### Incremental by default
The indexer compares the current indexable file set against persisted
mtime, size, and content hashes, so unstaged, staged, untracked, and
deleted files are detected without relying on commits. Deleted files get
removed from the vector store. Embedding is independently incremental:
changed files are re-chunked, unchanged chunk vectors are reused, and
only new or changed embedding text is sent to the provider.

### Ignore-aware indexing
Indexing starts from source-like files, then applies each repo's
`.gitignore` so ignored build output, caches, secrets, and local
artifacts stay out of the knowledge base. Add a repo-root
`index.ignore` file for indexing-only rules. It uses `.gitignore`
syntax, with `!pattern` acting as a force-include override when it
collides with `.gitignore`.

```gitignore
# index.ignore
generated/
!dist/public-api.js
```

Inspect the effective file set before changing filters:

```sh
npm run index:file-report -- /path/to/repo-or-workspace
```

### Chunk-level embedding reuse
Freshness is file-based instead of commit-based. The indexer compares the
current indexable file set against `index_meta.json` using mtime, size, and
content hashes, so unstaged and untracked edits are picked up. Changed files are
re-chunked locally, but embedding requests are only made for chunks whose
`embedText` hash changed. Unchanged chunks in the same file keep
their existing vectors and are reinserted with updated line metadata.

Embedding cache reuse is guarded by a provider fingerprint containing backend,
model, base URL, dimensions, and task prefixes. Changing the embedding backend
forces a rebuild instead of mixing incompatible vectors.

### Hybrid retrieval, four phases
1. **Vector ⫽ BM25 in parallel** — semantic recall + lexical recall.
2. **Reciprocal Rank Fusion** — combine without one dominating.
3. **AST tripartite expansion** — pull in callers, callees, and
   type references via the project graph.
4. **Cross-encoder rerank** — Qwen3-Reranker by default; Cohere /
   Voyage / OpenAI-compatible swappable.

The query classifier picks adaptive weights — identifiers lean
BM25, natural-language leans vector, error codes lean both.

### Six embedding providers, four rerankers
**Embed:** Codestral · Voyage · OpenAI · Ollama · Gemini OAuth ·
OpenAI-compatible · `auto` (picks based on what's configured).
**Rerank:** Ollama (default) · Cohere · Voyage · OpenAI-compatible.
Plug in whatever fits your cost/quality/latency curve.

### Project graph
A `graphology` directed multi-graph stitches every repo together.
Nodes are entities (functions, classes, types, modules), edges are
imports / calls / inheritance / contains / type-refs. Louvain
community detection clusters semantically related code so retrieval
can surface "the auth subsystem" rather than four scattered files.

### Cross-repo edge detection
Fourteen strategies covering shared types, Kafka topics, HTTP
endpoints, gRPC, databases, env vars, npm/workspace deps, k8s,
docker-compose, proto definitions, Redis, S3, and shared constants.
Plus an LLM-inferred semantic edge layer for the cases regex can't
catch.

### LLM-driven where it matters
Repo profiling (fingerprint files → LLM → typed `RepoProfile`,
cached by fingerprint hash), semantic edge inference, project
summary generation, RAG quality evaluation. All routed through
`@anvil/agent-core` so the same router, retries, and cost ledger
that power the agent stack power knowledge ingestion.

### Structural hashing
`computeStructuralHash` canonicalizes source — strips comments,
collapses whitespace, normalizes identifiers — and SHA-256s the
result. Used for chunk dedup *and* shared with `@anvil/memory-core`
so memory drift detection and chunk dedup speak the same language.

---

## Architecture at a glance

```
   git repo(s)
       │
       ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Indexing                                               │
   │   walk + git diff → tree-sitter chunks → AST graph      │
   │           │              │            │                 │
   │           ▼              ▼            ▼                 │
   │     LanceDB         BM25 (FTS)    project graph         │
   │     (vectors)                     + cross-repo edges    │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  HybridRetriever                                        │
   │   query classifier ─▶ adaptive weights                  │
   │   vector ⫽ BM25  →  RRF  →  AST expansion  →  rerank    │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
                       ranked chunks + graph context
```

One engine, one retained consumer: `@esankhan3/code-search-mcp` exposes
the retriever as MCP tools that any agent can call.

---

## Storage layout

```
~/.anvil/knowledge-base/<project>/
  chunks.json                    # canonical chunks (consumed by embedder)
  deleted_files.json             # incremental embed cleanup
  system_graph_v2.json           # merged project graph
  PROJECT_GRAPH.json             # LLM-generated semantic graph
  PROJECT_SUMMARY.md             # human-readable companion
  lancedb/                       # vector store
  <repo>/
    profile.json                 # cached RepoProfile
    graph.json                   # per-repo AST graph
    GRAPH_REPORT.md              # quality report
    index_meta.json              # { lastIndexedSha, files, chunkCount }
```

Everything is on disk, inspectable, git-friendly where it makes
sense (project graph + summary).

---

## Philosophy

**Chunks should follow code shape, not byte count.** AST boundaries
keep functions whole. Retrieval quality starts at the chunker.

**No single retrieval signal is enough.** Vector misses identifiers.
BM25 misses paraphrases. Graph misses everything text-shaped.
Hybrid + adaptive weighting is the only honest answer.

**Incremental or nothing.** Anvil indexes on every pipeline run.
A full re-index isn't acceptable; the engine treats the previous
SHA as a load-bearing input.

**No vendor lock-in.** LanceDB on disk. `graphology` in-process.
Pluggable embedders + rerankers. Swap any layer without rewriting
the rest.

**One focused surface.** MCP users get retrieval through tool calls, and
the indexing/retrieval pipeline stays concentrated in this package.

---

## Status

Stable: chunking, AST graph, hybrid retrieval, incremental
indexing, six embedders, four rerankers, fourteen cross-repo
strategies, project graph, structural hashing. In flight: richer
graph queries and a deeper RAG-eval harness.

---

## Part of [Anvil](../../) — the AI development pipeline.
