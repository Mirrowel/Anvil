# @anvil/knowledge-core

Shared knowledge stack for `@esankhan3/anvil-cli` and `@esankhan3/code-search-mcp`. Owns chunking, file-walking, AST/tree-sitter parsing, embedders, vector store, BM25, hybrid retrieval, reranker, project graph, and structural hashing.

## Status

Workspace-internal package, scaffolded by Phase 1 of [`KNOWLEDGE-CORE-EXTRACT-PLAN.md`](../../KNOWLEDGE-CORE-EXTRACT-PLAN.md). See [`KNOWLEDGE-CORE-ADR.md`](../../KNOWLEDGE-CORE-ADR.md) for the architectural decisions.

Currently exports: `types.ts` only. Subsequent phases hoist the rest of the duplicated tree.

## Consume

```ts
import type { CodeChunk, ScoredChunk, RetrievalResult } from '@anvil/knowledge-core';
```

Both consumers declare it as a workspace dep:

```json
"dependencies": {
  "@anvil/knowledge-core": "*"
}
```

## Build

```sh
npm -w @anvil/knowledge-core run build
```

`tsc -b` emits to `dist/`. Root `tsc -b` builds it transitively via project references.

## Layout

```
src/
├── index.ts          public barrel
└── types.ts          shared interfaces (CodeChunk, ScoredChunk, EmbeddingProvider, …)
```
