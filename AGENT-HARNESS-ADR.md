# Agent Harness — Architecture Decision Record

> Companion to [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md). Locks the decisions, schemas, and search orders the executable plan refers to.
>
> **Status:** Phase 0 — locked 2026-04-29.
> **Depends on:** [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md) (shipped), [`AGENT-OBSERVABILITY-PLAN.md`](./AGENT-OBSERVABILITY-PLAN.md) (shipped — telemetry spans pick up skill + MCP attributes for free).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/agent-core/` exists | ✅ |
| `packages/agent-core/src/registry.ts` exists | ✅ |
| `packages/agent-core/src/agent/` exists (existing AgentManager subprocess machinery from Plan A Phase 6 — separate concept from this plan's headless `runAgent`) | ✅ |
| `packages/agent-core/src/skills/` not yet present | ✅ |
| `packages/agent-core/src/mcp/` not yet present | ✅ |
| `packages/agent-core/src/headless/` not yet present | ✅ |
| `@modelcontextprotocol/sdk` not yet a dep of `agent-core` | ✅ (already a dep of `code-search-mcp` server side, so the workspace lockfile already carries it) |
| `.claude/skills/` does not exist at repo root | ✅ |
| `AGENT-HARNESS-ADR.md` not yet written | ✅ → this file |

No reconciliation needed.

---

## 2. Decisions

### H1 — Skill format

**Choice:** Anthropic-OpenAI **SKILL.md** standard. Frontmatter (`name`, `description`, optional `allowed-tools`, `disable-model-invocation`, `version`) + markdown body.

**Why:** Open standard adopted by both Anthropic (Oct 2025) and OpenAI Codex CLI (Dec 2025). Skills authored for Anvil work in Claude Code, Codex CLI, ChatGPT GPTs, and reverse — zero vendor lock-in. Reference: <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>.

### H2 — Skills directory

**Choice:** `.claude/skills/<skill-name>/SKILL.md` per-project; `$HOME/.claude/skills/<skill-name>/SKILL.md` user-global. Override via `ANVIL_SKILLS_DIR` env or `factory.yaml#skills.path`.

**Why:** `.claude/skills/` is the convention every consumer recognizes today.

### H3 — Skill discovery time

**Choice:** Eagerly scan at agent-invocation start; cache per process for the lifetime of the invocation.

**Why:** Filesystem reads are cheap; no need for hot-reload in v1. Reload happens on next invocation.

### H4 — Skill activation logic

**Choice:** Description-as-router. Skill descriptions go into the system prompt; the model decides which skill to "load" by mentioning it. v1 simplification: include all skills under a 32 KB combined byte budget, alphabetical order if truncation needed.

**Why:** Avoids inventing a custom selector before the model can ask for one. Anthropic's spec uses the same activation model.

### H5 — MCP client SDK

**Choice:** **`@modelcontextprotocol/sdk`** (official Anthropic-published TypeScript SDK).

**Why:** Multi-vendor governance (Anthropic, OpenAI, Google, Microsoft, AWS all consume MCP). Same SDK already powers `code-search-mcp` server, so the lockfile already carries it.

### H6 — MCP server discovery

**Choice:** Reads `mcp.json` (or `.mcp/servers.json`) per project. Supports `stdio` and `streamable-http` transports.

**Why:** Standard MCP config conventions; matches Claude Code's `mcp.json` shape.

### H7 — Tool merge layer

**Choice:** Built-in tools + MCP-discovered tools merged in agent-core, then passed to providers as a single `ToolSchema[]`. MCP tool names are namespaced as `<server>/<tool>`.

**Why:** Provider doesn't know about MCP; the agent does. Clean seam. Namespacing prevents collisions when two MCP servers each expose `read_file`.

### H8 — Headless entry signature

**Choice:** `runAgent(task: AgentTask, workspace: WorkspaceConfig): Promise<AgentTrajectory>`.

**Why:** Inspect AI external-agent shape. Lets Inspect AI (UK AISI's eval framework) ingest Anvil as `inspect eval --solver external` without conversion; same shape works for SWE-bench and custom benchmark scripts.

### H9 — AgentTrajectory format

**Choice:** Inspect-AI-compatible: `messages: Message[]`, `model: string`, `usage`, `costUsd`, `toolCalls`, `finalAnswer`, `finishReason`, `error?`, `durationMs`. Schema locked in §4 below.

**Why:** Same reasoning as H8 — preserves portability.

### H10 — Eval harness ownership

**Choice:** **Out of scope.** Only the headless entry lives in this plan. Inspect AI itself stays an optional external dep that callers add if they want it.

**Why:** Keeps `agent-core`'s dependency budget tight. Eval ownership is its own initiative.

### H11 — Skill tests format

**Choice:** Unit tests on the parser (frontmatter edge cases) + integration tests where a fixture skill is loaded and we assert it appears in the rendered system prompt at the documented anchor (`## Available Skills`).

**Why:** Standard. Avoids round-tripping LLM calls in unit tests; manual smoke covers the live path.

### H12 — Skill content security

**Choice:** Skills cannot `require()` arbitrary code in v1. Pure markdown body + sibling resources referenced by relative path; the agent decides whether to invoke them.

**Why:** Prevents malicious-skill RCE. Phase 7 (security review) revisits before any wider distribution channel ships.

---

## 3. Schema reference — `SKILL.md`

Frontmatter (YAML) + markdown body, separated by `---` lines.

### 3.1 Required fields

| Field | Type | Notes |
|---|---|---|
| `name` | string | Slug-safe identifier; used in registry + namespacing |
| `description` | string | One-sentence hook the model uses to decide whether to "load" the skill |

### 3.2 Optional fields

| Field | Type | Notes |
|---|---|---|
| `allowed-tools` | `string[]` | Constrains the caller's tool list while the skill is active. v1 semantics: intersection with caller's allowed tools (skills can subtract, never expand) |
| `disable-model-invocation` | bool | If true, skill is loaded only on explicit `--skill <name>` selection, not auto-routed. Default: false |
| `version` | string | Free-form (semver suggested) for cache busting |

### 3.3 Key normalization

Spec uses kebab-case keys (`allowed-tools`, `disable-model-invocation`). The parser MUST accept both kebab-case and camelCase (`allowedTools`, `disableModelInvocation`) and normalize to camelCase internally. Reason: existing real-world fixtures in the wild use both.

### 3.4 Example

```markdown
---
name: pr-summary
description: Produce a clear, structured summary of a pull request from its diff.
allowed-tools:
  - fs.read
  - shell.run
version: 1.0.0
---

# PR Summary skill

When the user asks "summarize this PR" or similar, …
```

---

## 4. Schema reference — `mcp.json`

Mirrors Claude Code's convention.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}" }
    },
    "internal-api": {
      "url": "https://internal-mcp.company.com/mcp",
      "headers": { "Authorization": "Bearer ${env:INTERNAL_API_TOKEN}" }
    }
  }
}
```

### 4.1 Server entry fields

| Field | Type | Required when | Notes |
|---|---|---|---|
| `command` | string | `transport === 'stdio'` (inferred when present) | |
| `args` | `string[]` | optional with `command` | |
| `env` | `Record<string, string>` | optional with `command` | values support `${env:VAR}` substitution |
| `url` | string | `transport === 'streamable-http'` (inferred when present) | |
| `headers` | `Record<string, string>` | optional with `url` | values support `${env:VAR}` substitution |

Transport is **inferred from shape**: `command` present → `stdio`; `url` present → `streamable-http`; never both.

### 4.2 `${env:VAR}` substitution

Only env-var indirection is supported. Inline secret literals are rejected (the loader logs a warning and drops the entry). No general string templating.

### 4.3 Search order for `mcp.json` (locked)

In order; first existing file wins:

1. `process.env.ANVIL_MCP_CONFIG` — full path override, takes precedence over everything
2. `<workspaceRoot>/mcp.json` — project root, the most discoverable location
3. `<workspaceRoot>/.mcp/servers.json` — alternative project location for users who keep mcp config out of repo root
4. `<workspaceRoot>/.claude/mcp.json` — Claude Code convention
5. `$HOME/.claude/mcp.json` — user-global fallback

Configs do **not** merge across locations — the first hit is the canonical one. Documented in `agent-core/src/mcp/config-loader.ts`'s docstring.

---

## 5. Schema reference — `AgentTask`

(Phase 4 ships this verbatim.)

```ts
export interface AgentTask {
  /** Human-readable task statement. Becomes the first user message. */
  prompt: string;

  /** Optional system-prompt prefix (rendered before the skills block). */
  systemPrompt?: string;

  /**
   * Allowed built-in tools. Intersected with skill `allowed-tools`
   * constraints. MCP-discovered tools are added unconditionally
   * (filtering MCP tools is an MCP-server-config concern, not a task concern).
   */
  allowedTools?: string[];

  /** Model identifier ('claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro', ...). */
  model: string;

  /** Provider hint: 'anthropic-cli' | 'anthropic-api' | 'openai-api' | ... */
  provider?: string;

  /** Max tokens per assistant turn. */
  maxTokens?: number;

  /** Sampling temperature. */
  temperature?: number;

  /**
   * Optional task ID for trace correlation — surfaced as `anvil.task_id`
   * on every `gen_ai.invoke` span emitted within this run.
   */
  taskId?: string;
}
```

---

## 6. Schema reference — `AgentTrajectory`

Inspect-AI-compatible.

```ts
export interface AgentTrajectory {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Tool name when role === 'tool' */
    name?: string;
    /** Originating assistant tool_call id when role === 'tool' */
    toolCallId?: string;
  }>;

  toolCalls: Array<{
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;

  /** Concrete model the run resolved to (post-fallback). */
  model: string;

  /** Aggregated across every LLM call in the run. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };

  /** Aggregated USD cost across every LLM call. */
  costUsd: number;

  /** Final assistant text (after the last non-tool turn). */
  finalAnswer: string;

  finishReason: 'end' | 'tool-use' | 'length' | 'error';

  /** Populated only when finishReason === 'error'. */
  error?: string;

  durationMs: number;
}
```

### 6.1 Aggregation semantics

- `usage.{cacheReadTokens, cacheWriteTokens}` are **summed only when at least one turn reports them**; otherwise the field is absent (matches the absence-stays-absent rule from observability ADR §O7).
- `costUsd` is summed using the same precedence as Plan B's cost-breakdown table — central pricing wins; adapter-reported `costUsd` is the fallback for unknown models.
- `finishReason` reflects the **terminal** state. Mid-loop tool-use turns do not change the final value.
- Tool-call loop hard cap is `MAX_TOOL_LOOP_ITERATIONS = 25` (Phase 4); reaching it sets `finishReason = 'length'` and `error = 'tool-loop iterations exhausted'`.

---

## 7. `WorkspaceConfig`

(Phase 4 ships verbatim.)

```ts
export interface WorkspaceConfig {
  /** Absolute path to the project workspace (where mcp.json + .claude/skills/ live). */
  rootDir: string;

  /** Optional override for factory.yaml path. */
  factoryYamlPath?: string;

  /** Extra env vars passed to subprocess adapters (CLI providers). */
  env?: Record<string, string>;
}
```

---

## 8. Skills directory resolution (locked)

Mirrors §3.4's mcp.json search; the **first** existing path wins, no merging:

1. `process.env.ANVIL_SKILLS_DIR` (full path override)
2. `<workspaceRoot>/.claude/skills/`
3. `$HOME/.claude/skills/`

If none of the above exists, `loadSkills()` returns `[]` and the skills block is omitted from the system prompt.

---

## 9. Per-phase commit log

| Phase | Status | Commit | Deviations |
|---|---|---|---|
| 0 — Audit + ADR | ✅ shipped 2026-04-29 | a1caa7e | none |
| 1 — Skill loader scaffold | ✅ shipped 2026-04-29 | 61b9e44 | Added unit tests (parser/loader/activator, 11 tests) inline rather than deferring to Phase 6, matching the cadence used by the observability initiative; Phase 6 still owns integration tests. Added `yaml@^2.8.3` as a direct dep of `agent-core` (already hoisted via cli) instead of relying on workspace hoisting. |
| 2 — Skill → system prompt integration | ✅ shipped 2026-04-29 | 113cc01 | Plan §2.3 said wire into `agent-manager.ts`; in reality `agent-manager.ts` is subprocess-lifecycle (no system-prompt build path). Shipped the helper surface (`render` + `resolveSkillsDir` + `applyToolPolicy` + `composeSkillContext`) for Phase 4's `runAgent` to consume; existing `runClaude`/`runGemini` paths in single-shot.ts remain unchanged because their callers don't ask for skills today. |
| 3 — MCP client at agent layer | ✅ shipped 2026-04-29 | 5e06e51 | Added `@modelcontextprotocol/sdk@^1.29.0` direct dep to agent-core (already on lockfile via `@esankhan3/code-search-mcp` server side). Live `McpAgentClient` connect/listTools/callTool against a real fixture server is deferred to Phase 5/6 integration tests; Phase 3 covers config-loader + tool-merger seams + transport inference + `${env:VAR}` substitution + collision/failure isolation. The `seen` set in `buildAgentToolset` is an extension over plan §3.6 — it makes the dispatch map ignore namespace collisions and warn instead of silently overwriting. |
| 4 — Headless `runAgent` entry | ✅ shipped 2026-04-29 | 633ed11 | Plan §4.3 envisions calling `LanguageModel.invoke()` from `ProviderRegistry`; in reality the registry holds `ModelAdapter`s and no agent-core adapter implements `LanguageModel` natively yet (per observability ADR §3.4). Reconciled by requiring callers to inject `LanguageModel` via the new `RunAgentOptions.model` parameter — a third optional argument extending plan §4.2's `(task, workspace)` signature. Tests use a `ScriptedLanguageModel` mock per plan §6.1. Built-in tool dispatch is also caller-injected (`builtInTools`, `builtInDispatch`) since agent-core has no built-in tools today; per-tool intersection-with-allowed-tools constraint application at the toolset level is a follow-up (Phase 2 helpers already enforce it at the policy layer). Wall-clock timeout (`timeoutMs`, default 600s) added on top of the iteration cap per §4.8 risk callout. Smoke run confirms 5-rank `mcp.json` discovery walks all the way to `$HOME/.claude/mcp.json` and degrades gracefully when an MCP server fails. |
| 5 — cli `--task` wire-up | ❌ skipped 2026-04-29 | — | Plan §5.1 marks this optional ("cli already has its own pipeline orchestration; runAgent is for *external* consumers"). Skipping was explicitly endorsed by the user. To make this useful would also require shipping a `ModelAdapter → LanguageModel` bridge first, which is its own follow-up. |
| 6 — Close-out: tests + Inspect AI recipe + ADR finalization | ✅ shipped 2026-04-29 | _this commit_ | Phase 6 closed. Added 6 `McpAgentClient` routing tests (namespacing, prefix-stripping, close idempotency, missing-command/url errors) using a fake SDK Client patched onto the private field. README extended with a "Agent harness" section documenting skills, MCP, and headless `runAgent` usage, plus an Inspect AI smoke recipe. Plan banner updated to "Shipped". Final agent-core: 81/81 tests; cli + code-search-mcp + dashboard builds clean; knowledge-core 62/62 baseline preserved. |

## Out of scope / known follow-ups

The following are explicit non-goals of this initiative and would land in
future plans:

1. **`ModelAdapter → LanguageModel` bridge.** Today `runAgent` requires
   callers to inject a `LanguageModel`; no agent-core adapter implements it
   natively. Shipping a bridge would let `runAgent` resolve from
   `ProviderRegistry` like plan §4.3 envisioned, and would unblock cli's
   optional `--task` wire-up (skipped Phase 5).
2. **Per-tool allowed-tools intersection at the toolset level.** Phase 2's
   `applyToolPolicy` enforces the policy semantically; runAgent currently
   passes the merged toolset (built-in + MCP) to `invoke` without filtering
   it through the policy. Adding a `filterToolset(tools, allowedTools)` step
   in `runAgent` would make the constraint terminal.
3. **Built-in tool registry.** `agent-core` has no built-in tools today;
   `runAgent` accepts caller-injected `builtInTools`/`builtInDispatch`. A
   future phase could hoist cli's pipeline tool implementations into
   `agent-core/src/tools/` so headless callers don't need to inject them.
4. **Native MCP-server fixture integration tests.** `McpAgentClient`
   transport selection (stdio vs streamable-http) is not exercised against a
   real fixture server — the routing tests use an injected fake SDK Client.
   A future fixture suite could spin up `@modelcontextprotocol/server-filesystem`
   over stdio + a tiny HTTP fixture for the streamable transport.
5. **Telemetry attributes for skills + MCP.** Plan B's `gen_ai.invoke` spans
   could carry `anvil.skills.activated` (count + names), `anvil.mcp.servers`
   (count), `anvil.mcp.tool_calls` (per-tool routing). Self-contained future
   phase.
6. **Security review for skill-content RCE.** Per ADR §H12 v1 disallows
   `require()` from skills, but the markdown body is inlined into the
   system prompt and could carry prompt-injection. A skill-signature manifest
   is a v2 concern.
