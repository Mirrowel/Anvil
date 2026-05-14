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

## Local MCP Usage

```sh
code-search-mcp --local /path/to/repo-or-workspace
```

## Index Filtering

Indexing respects each repo's `.gitignore` by default, so generated output,
secrets, caches, and other ignored files are not indexed.

Add an `index.ignore` file at the repo root for indexing-only rules. It uses
the same syntax as `.gitignore`:

```gitignore
# Exclude generated clients from search only
generated/

# Force-include one file even if .gitignore excludes it
!dist/public-api.js
```

Use this report before changing filters:

```sh
npm run index:file-report -- /path/to/repo-or-workspace
```

The report compares source-like files found in the tree with the files that
would be indexed, including `.gitignore` exclusions and `index.ignore`
overrides.

Useful environment variables:

- `CODE_SEARCH_DATA_DIR` - where indexes are stored.
- `EMBEDDING_PROVIDER` - embedding backend, such as `codestral`, `openai`, `ollama`, or `auto`.
- `EMBEDDING_API_KEY` - generic API key bridged to provider-specific variables.
- `RERANKER_PROVIDER` - reranker backend, or `none`.

See `packages/code-search-mcp/README.md` and `packages/code-search-mcp/CLAUDE.md` for MCP-specific details.
