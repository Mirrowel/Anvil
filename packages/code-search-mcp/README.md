# @esankhan3/code-search-mcp

**Your whole codebase, in any MCP client.**

A Model Context Protocol server that wraps `@anvil/knowledge-core`
behind an MCP-compliant tool surface. Point Claude Code, Claude
Desktop, or Cursor at it and your agent gains hybrid search,
caller tracing, and impact analysis across every repo you've
indexed — local or remote.

---

## Why "code search" needs more than grep

MCP gave us a clean way to expose tools to LLM agents. What's
missing is a *good* tool to expose. `grep` over your repo answers
"where is this string." Vector search over your repo answers
"what's semantically near this." Neither answers "who calls this
function and which other repos depend on it."

**code-search-mcp gives agents the answer.** Same hybrid retriever
that powers Anvil's pipelines, exposed through MCP. Agents get
AST-aware chunks, cross-repo graph traversal, and a whole-project
view — without you writing a single tool.

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "code-search": {
      "command": "code-search-mcp",
      "args": ["--local", "/path/to/your/projects"]
    }
  }
}
```

That's the whole setup. Claude Desktop now knows your codebase.

---

## Three modes, one binary

### Remote proxy (default)
```sh
code-search-mcp                  # default — proxies to remote
code-search-mcp --remote URL
```
Spawns a stdio MCP server that forwards to a remote HTTP server.
Zero local setup, zero local index — perfect for hosted
deployments where the index lives in the cloud and dev machines
stay light. Auth via `CODE_SEARCH_API_KEY`.

### Local
```sh
code-search-mcp --local /path/to/repos
code-search-mcp --local github:my-org/my-pattern
```
Discovers every repo under a path (or clones a GitHub org), builds
the knowledge base, and serves over stdio. Works fully offline if
your embedder + reranker are local (Ollama).

Local indexing respects each repo's `.gitignore`. To tune search-only
visibility, add `index.ignore` at the repo root using `.gitignore`
syntax. Normal patterns exclude files from indexing; `!pattern`
force-includes a file even when `.gitignore` excludes it.

```sh
npm run index:file-report -- /path/to/repos
```

Use the report to see the raw source tree, the effective index file
set, `.gitignore` exclusions, and `index.ignore` overrides.

Local mode also starts a debounced file watcher by default. Set
`CODE_SEARCH_WATCH=0` to disable it or `CODE_SEARCH_WATCH_DEBOUNCE=10s`
to tune the quiet period after edits. During the debounce window, old
results remain searchable but are marked as possibly stale when returned.
After the debounce, only changed/new chunks are embedded; unchanged
chunks from edited files reuse their stored vectors.

Startup also checks file freshness and the active embedding fingerprint before
declaring a cached index current. If stale, the server keeps existing results
available while a background refresh runs.

### Serve
```sh
code-search-mcp --serve --port 4000 --auth api-key
```
Boots an HTTP server (Streamable HTTP transport, SSE optional)
with `/mcp`, `/health`, `/status`, and an admin `POST /index`. Use
this to host one index for a whole team — every dev points their
client at the same URL.

---

## Tool surface

Eleven tools across four categories. Every one of them maps to a
function in `@anvil/knowledge-core` — you're getting the same
retrieval pipeline that powers the Anvil dashboard.

Agents should treat these MCP code-search tools as the default way to
discover and understand code in the current project. The MCP is already
scoped to the project/folder it was launched for, so tools do not need a
filesystem path unless you intentionally run a separate MCP instance for
another folder. Use local `grep`/`rg` only when you need raw exhaustive
line matches for a small exact-text lookup, especially inside files you
already know.

### Search
| Tool | What it does |
|---|---|
| `search_code` | Best overall/default search. Hybrid retrieval across indexed repos: vector semantic search + BM25 exact matching + graph expansion + reranking. Use for natural-language questions, identifiers, architecture discovery, feature tracing, and cross-repo investigations. |
| `search_semantic` | Vector-only search for meaning, paraphrases, and intent. Use when you do not know exact names. It can miss literal identifiers; use `search_code` when unsure. |
| `search_exact` | BM25-only keyword search. Use for exact identifiers, strings, file path fragments, routes, error codes, config keys, and log text. It does not understand natural language, synonyms, or intent. |

### Graph
| Tool | What it does |
|---|---|
| `get_repo_graph` | Summarizes the AST graph for one indexed repo: discovered functions, classes, methods, types, imports, and relationship counts. Expects a repo name, not a path. |
| `get_cross_repo_edges` | Shows inter-repo edges such as Kafka, HTTP, gRPC/protobuf, shared types, databases, env vars, workspace deps, Docker/Kubernetes, and inferred service relationships. |
| `find_callers` | Finds graph entities that call or reference a target function/method/symbol. Useful before changing or deleting code. Returns graph node identifiers; use `search_code` for snippets. |
| `find_dependencies` | Finds what a target function/method/symbol calls, imports, references, or depends on. Returns graph node identifiers; use `search_code` for snippets. |
| `impact_analysis` | Given a repo name and repo-relative file path, reports entities in scope, incoming dependents, and affected repos. Use before refactors or shared API/type changes. |

### Profiles
| Tool | What it does |
|---|---|
| `list_repos` | Lists indexed repos in the current project. Use this to get exact repo names for search filters, graph tools, profiles, and impact analysis. |
| `get_repo_profile` | Returns one repo's generated role, domain, description, tech stack, entry points, exposed interfaces, and consumed dependencies when profiling is enabled. |

### Index
| Tool | What it does |
|---|---|
| `index_status` | Reports whether the current project index is ready, idle/running/errored, progress, watcher state, stale-file warnings, log file, chunks, embedding provider, last indexed time, and indexed repos. |
| `index_start` | Starts indexing the current MCP project path. It does not accept a path. Poll `index_status` about every 30 seconds until Ready is `yes` and Indexing is `idle`. |

Plus four MCP resources via `code-search://`:
`repos`, `system-graph`, `repo/{name}/profile`, `repo/{name}/graph`.

---

## What makes the search good

This isn't a thin wrapper. The retrieval pipeline runs:

1. **Vector ⫽ BM25 in parallel** — semantic + lexical recall.
2. **Reciprocal Rank Fusion** — combine without one dominating.
3. **AST tripartite expansion** — pull in callers, callees, type
   refs via the project graph.
4. **Cross-encoder rerank** — Qwen3-Reranker by default; Cohere /
   Voyage / OpenAI-compatible swappable.

A query classifier picks adaptive weights — identifier queries
lean BM25, natural-language leans vector, error codes lean both.
You don't tune anything; the retriever does it per query.

---

## Multi-repo by design

Unlike single-repo code-search MCPs, this one is built for the
real world: a team has *many* repos, and the interesting
questions cross them. Where does this Kafka topic get consumed?
Which services depend on this proto? What service-mesh edges
exist between web and api?

Fourteen cross-repo edge strategies cover shared types, Kafka,
HTTP, gRPC, databases, env vars, npm/workspace deps, k8s,
docker-compose, proto, Redis, S3, and shared constants. Plus an
LLM-inferred semantic edge layer. `find_callers` works *across
repos*. So does `impact_analysis`.

---

## Server features

### Auth, three flavors
`none` (local-only, default 127.0.0.1 binding), `api-key`
(`Authorization: Bearer ...`, timing-safe compare), `jwt` (HS256,
signature + `exp` + `iss` validated). Public binding without auth
logs a warning, because that's what should happen.

### Rate limiting
In-memory sliding 1-minute window keyed by identity subject. Tune
per-deployment.

### Auto-reindex
`CODE_SEARCH_REINDEX_INTERVAL=30m` (or `1h`, `6h`, `0` to disable)
runs an incremental re-index in the background. Skips itself if a
manual index is already running. The timer is `unref`'d so it
doesn't keep the process alive.

### Status tracking
Every index call lands in a 50-entry FIFO history with start
timestamp, success / error, last duration. Available at
`GET /status`.

### Streamable HTTP sessions
Per-session `StreamableHTTPServerTransport`, max 100 concurrent
sessions, 30 min TTL. The remote proxy captures `mcp-session-id`
for continuity. SSE transport available as a fallback.

### Admin index endpoint
`POST /index` with `{ project, dirPath?, opts? }` triggers a
fresh index. Gated against concurrent runs. Auth-required when
auth is on.

---

## How it fits with the rest of Anvil

```
                    ┌─────────────────────────┐
                    │   MCP client            │
                    │   (Claude Code,         │
                    │    Claude Desktop,      │
                    │    Cursor, …)           │
                    └────────────┬────────────┘
                                 │ stdio / HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │   code-search-mcp       │
                    │   (this package)        │
                    │   tools + resources     │
                    └────────────┬────────────┘
                                 │ wraps
                                 ▼
                    ┌─────────────────────────┐
                    │   @anvil/knowledge-core │
                    │   AST chunks +          │
                    │   project graph +       │
                    │   hybrid retriever      │
                    └────────────┬────────────┘
                                 │ on disk
                                 ▼
                    ~/.anvil/knowledge-base/<project>/
```

Three different fronts, one knowledge stack:

- **The CLI** indexes via `anvil index` and retrieves during
  pipelines.
- **The dashboard** browses the project graph and surfaces
  retrieval results in pipeline UI.
- **code-search-mcp** exposes the same retriever to any MCP
  client.

If you've already indexed a project with `anvil index`, this
server picks it up — same `~/.anvil/knowledge-base/` path, same
LanceDB store, same graph files.

---

## Configuration

Everything is `CODE_SEARCH_*` env vars, single source of truth in
`src/core/env-config.ts`:

| Var | What it does |
|---|---|
| `CODE_SEARCH_SERVER` | Remote URL (proxy mode) |
| `CODE_SEARCH_API_KEY` | API key for proxy or serve modes |
| `CODE_SEARCH_DATA_DIR` | Override `~/.anvil/knowledge-base` |
| `CODE_SEARCH_REINDEX_INTERVAL` | `30m` / `1h` / `6h` / `0` |
| `CODE_SEARCH_MAX_FILES` | Max source files per repo, default `10000` |
| `CODE_SEARCH_MAX_FILE_SIZE` | Max source file bytes, default `2000000` |
| `CODE_SEARCH_MAX_CHUNKS` | Max chunks before aborting, default `200000` |
| `CODE_SEARCH_EMBEDDING_TIMEOUT_MS` | Embedding HTTP timeout, default `25000` |
| `CODE_SEARCH_EMBEDDING_MAX_RETRIES` | Retry count for retryable embedding failures, default `3` |
| `EMBEDDING_PROVIDER` | `auto` / `voyage` / `openai` / `nvidia` / `cohere` / `ollama` / … |
| `EMBEDDING_API_KEY` | Bridged to provider-specific var |
| `RERANKER_PROVIDER` | `ollama` / `cohere` / `voyage` / `none` |
| `OLLAMA_HOST` | Default `http://localhost:11434` |

---

## Philosophy

**Multi-repo or nothing.** Real codebases span repos. Code search
that doesn't is a toy.

**No vendor LLM SDK.** Anything LLM-driven (repo profiling,
semantic edges) routes through `@anvil/agent-core`'s single-shot —
the same router, retries, and cost ledger as the rest of Anvil.

**Three modes, one binary.** Remote proxy for hosted, local for
solo, serve for teams. The dispatcher is `src/index.ts:argv`.

**Stateless sessions.** HTTP sessions are in-memory by design.
Restart drops them; clients re-init on first request. No persistent
session store to maintain.

**Security defaults that don't bite.** Default bind is `127.0.0.1`
when auth is `none`. API keys compared timing-safe. JWT
signature + exp + iss validated. Public binding without auth
logs a warning instead of pretending it's fine.

---

## Status

Stable. The retrieval and graph layers move with
`@anvil/knowledge-core`; the MCP surface is locked. New tools
land additively.

---

## Part of [Anvil](../../) — the AI development pipeline.
