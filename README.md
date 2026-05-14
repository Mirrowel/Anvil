# Anvil Code Search MCP

This fork is narrowed to the Code Search MCP server and the packages it needs:

- `packages/code-search-mcp` - MCP stdio/HTTP server, tools, resources, auth, and indexing orchestration.
- `packages/knowledge-core` - repository discovery, chunking, AST graphing, embeddings, LanceDB storage, and retrieval.
- `packages/agent-core` - shared LLM runner used by knowledge-core for profiling and graph inference.

The old CLI, dashboard, pipeline, convention, and memory packages were removed so MCP work can move independently.

## Install

```sh
npm install
```

## Build

```sh
npm run build
```

To build only the MCP binary:

```sh
npm -w @esankhan3/code-search-mcp run build
```

## Test

```sh
npm test
```

## Local MCP Usage

```sh
code-search-mcp --local /path/to/repo-or-workspace
```

Useful environment variables:

- `CODE_SEARCH_DATA_DIR` - where indexes are stored.
- `EMBEDDING_PROVIDER` - embedding backend, such as `codestral`, `openai`, `ollama`, or `auto`.
- `EMBEDDING_API_KEY` - generic API key bridged to provider-specific variables.
- `RERANKER_PROVIDER` - reranker backend, or `none`.

See `packages/code-search-mcp/README.md` and `packages/code-search-mcp/CLAUDE.md` for MCP-specific details.
