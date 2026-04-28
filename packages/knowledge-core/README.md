# @anvil/knowledge-core

Shared knowledge stack consumed by `@esankhan3/anvil-cli` and `@esankhan3/code-search-mcp`. Owns chunking, file walking, AST parsing, embedders, vector store, BM25 + hybrid retrieval, reranker, project graph generation, structural hashing, and LLM-driven repo profiling.

Architectural decisions and rationale: [`KNOWLEDGE-CORE-ADR.md`](../../KNOWLEDGE-CORE-ADR.md).

## Status

Workspace-internal. The full extract per [`KNOWLEDGE-CORE-EXTRACT-PLAN.md`](../../KNOWLEDGE-CORE-EXTRACT-PLAN.md) shipped across Phases 1–8. `cli/src/knowledge/` retains only `context-assembler.ts` + `index.ts` (cli-only); `code-search-mcp/src/core/` retains only `env-config.ts` (mcp-only server config).

## Consume

```ts
import {
  // chunking
  chunkRepo, chunkChangedFiles,
  // walking
  walkDir, langFromExt, extractImports, extractNamedImports,
  // AST
  initTreeSitter, parseFile, supportedLanguages,
  buildAstGraph, generateGraphReport, incrementalGraphUpdate,
  // retrieval
  HybridRetriever, classifyQuery, QueryRouter,
  VectorStore,
  createReranker, type Reranker,
  createEmbeddingProvider, type EmbeddingProvider,
  // structural
  computeStructuralHash, computeStructuralHashes, deduplicateByStructure,
  // graph
  ProjectGraphBuilder, buildProjectGraph, loadProjectGraph,
  loadProjectSummary, getProjectGraphStatus, estimateProjectGraphCost,
  // profiling
  profileProject, loadAllProfiles, loadProfile,
  inferServiceMesh,
  // LLM
  runLLM, runClaude, runGemini, isLlmAvailable,
  // git diff (incremental indexing)
  getAllChanges, getChangedFilesList, getDeletedFilesList,
  // workspace
  detectWorkspace, detectTsconfigAliases,
  // cross-repo
  detectCrossRepoEdges, detectSemanticEdges,
  // indexing entry points
  KnowledgeIndexer, buildKBFromPath, embedFromPath, indexFromPath,
  getRetriever, discoverRepos,
  // config
  loadKnowledgeConfig, getKnowledgeBasePath, DEFAULT_CONFIG,
  type KnowledgeConfig,
  // types
  type CodeChunk, type ScoredChunk, type RetrievalResult,
  type IndexStats, type RepoProfile, type ServiceEndpoint,
  type GraphifyNode, type GraphifyEdge, type GraphifyOutput,
  type WorkspaceMap, type WorkspacePackage,
} from '@anvil/knowledge-core';
```

Both consumers declare it as a workspace dep:

```json
"dependencies": {
  "@anvil/knowledge-core": "*"
}
```

(npm 10 in this monorepo currently rejects the `workspace:*` URL protocol despite docs claiming support; `*` resolves the same way via the workspaces glob.)

## Build & test

```sh
npm -w @anvil/knowledge-core run build   # tsc -b → dist/
npm -w @anvil/knowledge-core test        # tsc + node:test runner against dist/__tests__
```

`tsc -b` from repo root builds it transitively via project references (declared in root `tsconfig.json`).

## Layout

```
src/
├── index.ts                          # public barrel
├── types.ts                          # shared interfaces
├── config.ts                         # config + getKnowledgeBasePath
├── claude-runner.ts                  # LLM runner (CLI/API/none modes)
│
├── chunker.ts                        # source → chunks
├── file-walker.ts                    # filesystem traversal + import extraction
├── git-diff.ts                       # incremental indexing diff
├── tree-sitter-parser.ts             # AST parsing (wasm grammars)
│
├── ast-graph-builder.ts              # graph from AST
├── cross-repo-detector.ts            # cross-repo edge detection
├── graph-metrics.ts                  # graph quality reports
├── graph-query.ts                    # graph traversal helpers
├── semantic-edge-detector.ts         # LLM-inferred edges
├── workspace-detector.ts             # monorepo package discovery
│
├── project-graph-builder-core.ts     # ProjectGraphBuilder class
├── project-graph-builder.ts          # LLM-powered project graph functions
│
├── embedder.ts                       # 6 embedding providers + factory
├── vector-store.ts                   # LanceDB-backed vector store
├── reranker.ts                       # 4 reranker providers + factory
├── query-classifier.ts               # query intent classification
├── query-router.ts                   # repo routing
├── retriever.ts                      # HybridRetriever (vec+BM25+graph+rerank)
│
├── repo-profiler.ts                  # LLM-driven repo understanding
├── service-mesh-inferrer.ts          # LLM-inferred cross-repo connections
├── rag-evaluator.ts                  # retrieval eval harness
│
├── structural-hasher.ts              # structural code hashing for dedup
└── indexer.ts                        # orchestration entry points
```

## Native deps (declared here, hoisted via npm workspaces)

- `@lancedb/lancedb` — vector store
- `web-tree-sitter` + `tree-sitter-wasms` — AST parsing
- `graphology` (+ `-communities-louvain`, `-metrics`, `-types`) — graph algorithms

Consumers no longer declare these — they resolve via npm hoisting.
