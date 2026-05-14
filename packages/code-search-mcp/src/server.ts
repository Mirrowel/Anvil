/**
 * MCP Server — registers tools and resources, handles lifecycle.
 * Supports stdio (default) and HTTP transports with auth.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { FSWatcher } from 'chokidar';

import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerGraphTools, handleGraphTool } from './tools/graph.js';
import { registerProfileTools, handleProfileTool } from './tools/profile.js';
import { registerIndexTools, handleIndexTool } from './tools/index-tools.js';
import { registerResources, handleResource } from './resources/resources.js';
import { getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';
import { indexFromPath } from '@esankhan3/anvil-knowledge-core';
import { KnowledgeIndexer } from '@esankhan3/anvil-knowledge-core';
import { discoverRepos, ensureIndexIgnore, isIndexableFile, SKIP_DIRS } from '@esankhan3/anvil-knowledge-core';
import { loadServerConfig, type ServerConfig } from './core/env-config.js';
import { startHttpTransport } from './transports/http-transport.js';

// State shared across tools
export interface IndexingState {
  status: 'uninitialized' | 'idle' | 'indexing' | 'error';
  phase: string | null;       // current phase: profiling, chunking, embedding, etc.
  message: string | null;     // latest progress message
  percent: number;            // 0-100
  startedAt: number | null;   // epoch ms when current indexing started
  error: string | null;       // last error message
  lastSuccess: string | null; // ISO timestamp of last successful index
  lastDurationMs: number;     // duration of last successful index
  history: Array<{            // recent indexing events (last 50)
    timestamp: string;
    type: 'start' | 'progress' | 'complete' | 'error';
    message: string;
  }>;
  watcherEnabled: boolean;
  debounceMs: number;
  pendingFiles: number;
  lastRefresh: string | null;
  lastRefreshSummary: string | null;
}

export interface ServerContext {
  projectName: string;
  directoryPath: string | null;
  indexReady: boolean;
  profilingEnabled: boolean;
  startedAt: number;
  indexing: IndexingState;
  logFile: string | null;
  autoIndexTask: Promise<void> | null;
  initialIndexCheckDone: boolean;
  startIndexing: () => Promise<{ started: boolean; message: string }>;
  watcher: FSWatcher | null;
  pendingWatchFiles: Set<string>;
  staleWatchFiles: Set<string>;
  watchTimer: NodeJS.Timeout | null;
  watchDrainRunning: boolean;
  watchFollowUpNeeded: boolean;
}

function projectNameFromPath(path: string): string {
  return basename(resolve(path)) || 'project';
}

function log(ctx: Pick<ServerContext, 'logFile'> | null, message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const detail = error instanceof Error ? `${error.stack || error.message}` : error ? String(error) : '';
  const line = `[${timestamp}] ${message}${detail ? `\n${detail}` : ''}`;
  console.error(line);
  if (!ctx?.logFile) return;
  try {
    appendFileSync(ctx.logFile, `${line}\n`, 'utf-8');
  } catch {
    // Logging must never break the MCP server.
  }
}

function initLogFile(projectName: string): string | null {
  try {
    const kbPath = getKnowledgeBasePath(projectName);
    mkdirSync(kbPath, { recursive: true });
    return join(kbPath, 'code-search-mcp.log');
  } catch {
    return null;
  }
}

/** Create a wired MCP Server instance (shared logic for stdio and HTTP sessions) */
function createMcpServerInstance(ctx: ServerContext) {
  const server = new Server(
    { name: 'code-search-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const allTools = [
    ...registerSearchTools(),
    ...registerGraphTools(),
    ...registerProfileTools({ profilingEnabled: ctx.profilingEnabled }),
    ...registerIndexTools(),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const searchResult = await handleSearchTool(name, args, ctx);
    if (searchResult) return searchResult;

    const graphResult = await handleGraphTool(name, args, ctx);
    if (graphResult) return graphResult;

    const profileResult = await handleProfileTool(name, args, ctx);
    if (profileResult) return profileResult;

    const indexResult = await handleIndexTool(name, args, ctx);
    if (indexResult) return indexResult;

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'index',
        title: 'Index Project',
        description: 'Start indexing the current project, then poll index_status until indexing completes.',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'index') {
      return { messages: [], description: `Unknown prompt: ${request.params.name}` };
    }

    return {
      description: 'Start and monitor project indexing.',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Start indexing the current project by calling the `index_start` MCP tool.',
            'After starting, call `index_status` to monitor progress.',
            'Indexing can take several minutes. If the agent has a shell/sleep tool available, wait about 30 seconds between status checks instead of polling continuously.',
            'Keep polling `index_status` until Ready is `yes` and Indexing is `idle`, or stop and report the Error field if status becomes `error`.',
            'Do not call search, graph, profile, or resource tools until indexing is complete.',
          ].join('\n'),
        },
      }],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: registerResources(ctx),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return handleResource(request.params.uri, ctx);
  });

  return server;
}

export async function startServer(
  projectName: string,
  directoryPath: string | null,
): Promise<void> {
  const config = loadServerConfig();

  const ctx: ServerContext = {
    projectName,
    directoryPath,
    indexReady: false,
    profilingEnabled: config.llmMode !== 'none',
    startedAt: Date.now(),
    logFile: initLogFile(projectName),
    autoIndexTask: null,
    initialIndexCheckDone: false,
    startIndexing: async () => startManualIndex(ctx),
    watcher: null,
    pendingWatchFiles: new Set(),
    staleWatchFiles: new Set(),
    watchTimer: null,
    watchDrainRunning: false,
    watchFollowUpNeeded: false,
    indexing: {
      status: 'idle',
      phase: null,
      message: 'Checking for an existing index...',
      percent: 0,
      startedAt: null,
      error: null,
      lastSuccess: null,
      lastDurationMs: 0,
      history: [],
      watcherEnabled: false,
      debounceMs: 10_000,
      pendingFiles: 0,
      lastRefresh: null,
      lastRefreshSummary: null,
    },
  };

  // Log resolved LLM configuration
  const llmInfo = config.llmMode === 'none'
    ? 'disabled (profiling + service mesh skipped)'
    : config.llmMode === 'api'
      ? `api → ${config.llmProvider}/${config.llmModel}${config.llmApiKey ? '' : ' (WARNING: no API key!)'}`
      : `cli → ${config.claudeBin}`;
  log(ctx, `[code-search-mcp] LLM: ${llmInfo}`);
  log(ctx, `[code-search-mcp] Log file: ${ctx.logFile || 'disabled'}`);

  if (ctx.directoryPath) {
    const created = ensureIndexIgnore(ctx.directoryPath);
    if (created) {
      log(ctx, `[code-search-mcp] Created index.ignore from example template in ${ctx.directoryPath}`);
    }
  }

  // --- Load/refresh existing indexes in the background ---
  // First-time indexing is intentionally manual to avoid indexing accidental
  // workspaces. Existing indexes still load immediately and stale indexes keep
  // refreshing in the background as before.
  ctx.autoIndexTask = initializeExistingIndex(ctx).catch((err) => {
    log(ctx, `[code-search-mcp] Background index initialization task failed`, err);
  });

  // --- Start transport ---
  if (config.transport === 'stdio') {
    const server = createMcpServerInstance(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
      log(ctx, `[code-search-mcp] Server running for "${projectName}" (stdio)`);
  } else {
    // Security: warn if auth=none with non-localhost binding
    if (config.authMode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
      log(ctx, `[code-search-mcp] WARNING: Auth is disabled but server binds to ${config.host}. Any machine on the network can access your code search API.`);
      log(ctx, `[code-search-mcp] Set CODE_SEARCH_AUTH_MODE=api-key or CODE_SEARCH_HOST=127.0.0.1 for security.`);
    }

    await startHttpTransport({
      config,
      createMcpServer: async () => ({
        server: createMcpServerInstance(ctx),
      }),
      onReady: (url) => {
        log(ctx, `[code-search-mcp] Server running for "${projectName}" at ${url}/mcp`);
        log(ctx, `[code-search-mcp] Health:  GET  ${url}/health`);
        log(ctx, `[code-search-mcp] Status:  GET  ${url}/status`);
        log(ctx, `[code-search-mcp] Index:   POST ${url}/index`);
        log(ctx, `[code-search-mcp] Auth: ${config.authMode}`);
      },
      getHealth: () => ({
        project: ctx.projectName,
        indexReady: ctx.indexReady,
        indexing: ctx.indexing.status,
        uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
        transport: config.transport,
        authMode: config.authMode,
      }),
      getStatus: () => ({
        project: ctx.projectName,
        directoryPath: ctx.directoryPath,
        indexReady: ctx.indexReady,
        uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
        indexing: {
          ...ctx.indexing,
          elapsedMs: ctx.indexing.startedAt ? Date.now() - ctx.indexing.startedAt : null,
        },
      }),
      onIndex: async (body) => {
        const { resolve } = await import('node:path');
        const { existsSync } = await import('node:fs');

        const dirPath = resolve(body.path);
        if (!existsSync(dirPath)) {
          throw new Error(`Path does not exist: ${dirPath}`);
        }

        if (ctx.indexing.status === 'indexing') {
          throw new Error(`Indexing already in progress (phase: ${ctx.indexing.phase}). Wait for it to complete or check GET /status.`);
        }

        const project = body.project || projectNameFromPath(dirPath);
        if (ctx.directoryPath && resolve(ctx.directoryPath) !== dirPath) {
          await stopFileWatcher(ctx);
        }

        ctx.projectName = project;
        ctx.directoryPath = dirPath;
        ctx.logFile = initLogFile(project);

        const stats = await trackedIndex(ctx, project, dirPath, {
          force: body.force,
          label: 'admin-index',
        });

        return {
          status: 'ok',
          project,
          path: dirPath,
          chunks: stats.totalChunks,
          repos: stats.repos.length,
          crossRepoEdges: stats.crossRepoEdges,
          durationMs: stats.indexDurationMs,
        };
      },
    });
  }

  // --- Scheduled reindex interval (server-side only) ---
  const reindexIntervalMs = parseReindexInterval();
  if (reindexIntervalMs > 0 && ctx.directoryPath) {
    log(ctx, `[code-search-mcp] Auto-reindex every ${Math.round(reindexIntervalMs / 60_000)}m`);
    setInterval(async () => {
      if (!ctx.directoryPath) return;
      if (ctx.indexing.status === 'indexing') {
        log(ctx, `[auto-reindex] skipped: indexing already running (${ctx.indexing.phase ?? 'unknown phase'})`);
        return;
      }
      if (!ctx.indexReady) {
        log(ctx, '[auto-reindex] skipped: index is not initialized');
        return;
      }
      try {
        await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-reindex' });
      } catch (err) {
        log(ctx, `[auto-reindex] Failed`, err);
      }
    }, reindexIntervalMs).unref();
  }
}

/**
 * Parse CODE_SEARCH_REINDEX_INTERVAL env var.
 * Accepts: "30m", "1h", "6h", "0" (disabled). Default: 0 (disabled).
 */
function parseReindexInterval(): number {
  const raw = process.env.CODE_SEARCH_REINDEX_INTERVAL?.trim();
  if (!raw || raw === '0' || raw === 'none') return 0;

  const match = raw.match(/^(\d+)(m|h)$/);
  if (!match) {
    console.error(`[code-search-mcp] Invalid REINDEX_INTERVAL "${raw}" — use "30m", "1h", etc. Disabling.`);
    return 0;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  return unit === 'h' ? value * 60 * 60_000 : value * 60_000;
}

function parseDurationEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMs;
  const match = raw.match(/^(\d+)(ms|s|m)?$/);
  if (!match) {
    console.error(`[code-search-mcp] Invalid ${name}="${raw}" — use "500ms", "10s", or "1m". Falling back to ${fallbackMs}ms.`);
    return fallbackMs;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2] ?? 'ms';
  if (unit === 'm') return value * 60_000;
  if (unit === 's') return value * 1000;
  return value;
}

async function startFileWatcher(ctx: ServerContext): Promise<void> {
  if (ctx.watcher) return;
  if (!ctx.indexReady) return;
  if (!ctx.directoryPath) {
    log(ctx, '[watcher] disabled: no directory path configured');
    return;
  }
  const enabled = (process.env.CODE_SEARCH_WATCH ?? '1').trim() !== '0';
  if (!enabled) {
    log(ctx, '[watcher] disabled by CODE_SEARCH_WATCH=0');
    return;
  }
  const debounceMs = parseDurationEnv('CODE_SEARCH_WATCH_DEBOUNCE', 10_000);
  ctx.indexing.watcherEnabled = true;
  ctx.indexing.debounceMs = debounceMs;

  const { watch } = await import('chokidar');
  const watcher = watch(ctx.directoryPath, {
    ignoreInitial: true,
    ignored: (path, stats) => shouldIgnoreWatchPath(ctx, resolve(path), stats?.isDirectory() ?? false),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  ctx.watcher = watcher;

  const onChange = async (path: string) => {
    const absPath = resolve(path);
    if (!watchPathNeedsRefresh(ctx, absPath)) {
      log(ctx, `[watcher] ignored unchanged path event: ${absPath}`);
      return;
    }
    const before = ctx.pendingWatchFiles.size;
    ctx.pendingWatchFiles.add(absPath);
    ctx.staleWatchFiles.add(absPath);
    ctx.indexing.pendingFiles = ctx.pendingWatchFiles.size;
    log(ctx, `[watcher] queued path (${ctx.indexing.pendingFiles} pending): ${absPath}`);
    scheduleWatchDrain(ctx, debounceMs, before === 0);
  };

  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', onChange);
  watcher.on('ready', () => log(ctx, `[watcher] ready for ${ctx.directoryPath}`));
  watcher.on('error', (err) => log(ctx, '[watcher] error', err));
  log(ctx, `[code-search-mcp] File watcher enabled at ${ctx.directoryPath} (debounce ${debounceMs}ms)`);
}

function scheduleWatchDrain(ctx: ServerContext, delayMs: number = ctx.indexing.debounceMs, logDebounce: boolean = false): void {
  if (ctx.watchTimer) clearTimeout(ctx.watchTimer);
  if (logDebounce) log(ctx, `[watcher] debounce started (${delayMs}ms)`);
  ctx.watchTimer = setTimeout(() => {
    void flushWatchedChanges(ctx);
  }, delayMs);
}

async function stopFileWatcher(ctx: ServerContext): Promise<void> {
  if (ctx.watchTimer) {
    clearTimeout(ctx.watchTimer);
    ctx.watchTimer = null;
  }
  ctx.pendingWatchFiles.clear();
  ctx.staleWatchFiles.clear();
  ctx.indexing.pendingFiles = 0;
  ctx.indexing.watcherEnabled = false;
  ctx.watchDrainRunning = false;
  ctx.watchFollowUpNeeded = false;
  if (!ctx.watcher) return;

  const watcher = ctx.watcher;
  ctx.watcher = null;
  await watcher.close();
}

function shouldIgnoreWatchPath(ctx: ServerContext, absPath: string, isDirectory: boolean): boolean {
  if (!ctx.directoryPath) return true;
  const relPath = relative(ctx.directoryPath, absPath);
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  const name = basename(absPath);
  if (isDirectory) return SKIP_DIRS.has(name);
  // Keep this predicate cheap: chokidar calls it during startup discovery for
  // many paths. Full indexability checks can invoke git/read file bytes and are
  // deferred to actual change handling instead.
  return false;
}

function watchPathNeedsRefresh(ctx: ServerContext, absPath: string): boolean {
  const name = basename(absPath);
  if (isIndexControlFile(name)) return true;
  const repo = findRepoForPath(ctx, absPath);
  if (!repo) return true;
  if (!existsSync(absPath)) return true;
  const filePath = relative(repo.path, absPath);
  try {
    return new KnowledgeIndexer().fileNeedsRefresh(ctx.projectName, repo.name, repo.path, filePath);
  } catch {
    return true;
  }
}

function findRepoForPath(ctx: ServerContext, absPath: string): { name: string; path: string; language: string } | null {
  if (!ctx.directoryPath) return null;
  return findRepoInList(safeDiscoverRepos(ctx.directoryPath), absPath);
}

function safeDiscoverRepos(directoryPath: string): Array<{ name: string; path: string; language: string }> {
  try {
    return discoverRepos(directoryPath);
  } catch {
    return [];
  }
}

function findRepoInList(repos: Array<{ name: string; path: string; language: string }>, absPath: string): { name: string; path: string; language: string } | null {
  return repos
    .filter((repo) => absPath === repo.path || absPath.startsWith(`${repo.path}\\`) || absPath.startsWith(`${repo.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

async function flushWatchedChanges(ctx: ServerContext): Promise<void> {
  if (!ctx.directoryPath) {
    log(ctx, '[watcher] flush skipped: no directory path');
    return;
  }
  if (ctx.watchDrainRunning) {
    ctx.watchFollowUpNeeded = true;
    log(ctx, '[watcher] flush coalesced: watcher drain already running');
    return;
  }
  if (ctx.indexing.status === 'indexing') {
    ctx.watchFollowUpNeeded = true;
    log(ctx, `[watcher] flush queued: index already running (${ctx.indexing.phase ?? 'unknown phase'})`);
    return;
  }
  if (!ctx.indexReady) {
    log(ctx, '[watcher] flush skipped: index is not initialized');
    return;
  }
  ctx.watchDrainRunning = true;
  ctx.watchTimer = null;
  try {
    while (true) {
      const pending = [...ctx.pendingWatchFiles];
      const count = pending.length;
      const followUp = ctx.watchFollowUpNeeded;
      ctx.pendingWatchFiles.clear();
      ctx.watchFollowUpNeeded = false;
      ctx.indexing.pendingFiles = 0;

      if (count === 0 && !followUp) {
        log(ctx, '[watcher] flush skipped: no pending files');
        return;
      }

      if (ctx.indexing.status === 'indexing') {
        ctx.watchFollowUpNeeded = true;
        log(ctx, `[watcher] drain paused: index already running (${ctx.indexing.phase ?? 'unknown phase'})`);
        return;
      }

      if (count > 0) {
        log(ctx, `[watcher] flushing ${count} path(s): ${pending.slice(0, 12).join(', ')}${pending.length > 12 ? `, ... ${pending.length - 12} more` : ''}`);
      } else {
        log(ctx, '[watcher] running follow-up refresh after concurrent changes');
      }

      await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'watch-reindex' });
      ctx.indexing.lastRefresh = new Date().toISOString();
      ctx.indexing.lastRefreshSummary = count > 0 ? `${count} watched path(s)` : 'follow-up refresh';
      removeFreshWatchFiles(ctx, pending);
      log(ctx, `[watcher] refresh complete for ${count} path(s)`);

      if (ctx.pendingWatchFiles.size === 0 && !ctx.watchFollowUpNeeded) return;
      log(ctx, `[watcher] continuing drain: ${ctx.pendingWatchFiles.size} pending path(s), followUp=${ctx.watchFollowUpNeeded}`);
    }
  } catch (err) {
    log(ctx, '[watcher] reindex failed', err);
  } finally {
    ctx.watchDrainRunning = false;
    ctx.indexing.pendingFiles = ctx.pendingWatchFiles.size;
    if (ctx.pendingWatchFiles.size > 0 || ctx.watchFollowUpNeeded) {
      if (ctx.watchTimer) clearTimeout(ctx.watchTimer);
      ctx.watchTimer = setTimeout(() => {
        void flushWatchedChanges(ctx);
      }, ctx.indexing.debounceMs);
      log(ctx, `[watcher] rescheduled drain (${ctx.indexing.debounceMs}ms): ${ctx.pendingWatchFiles.size} pending path(s), followUp=${ctx.watchFollowUpNeeded}`);
    }
  }
}

function removeFreshWatchFiles(ctx: ServerContext, paths: string[]): void {
  if (!ctx.directoryPath || paths.length === 0) return;
  const repos = safeDiscoverRepos(ctx.directoryPath);
  const indexer = new KnowledgeIndexer();
  for (const absPath of paths) {
    if (isIndexControlFile(basename(absPath))) {
      ctx.staleWatchFiles.delete(absPath);
      continue;
    }
    const repo = findRepoInList(repos, absPath);
    if (!repo) {
      ctx.staleWatchFiles.delete(absPath);
      continue;
    }
    if (!existsSync(absPath) || !isIndexableFile(repo.path, absPath)) {
      ctx.staleWatchFiles.delete(absPath);
      continue;
    }
    const filePath = relative(repo.path, absPath);
    try {
      if (!indexer.fileNeedsRefresh(ctx.projectName, repo.name, repo.path, filePath)) {
        ctx.staleWatchFiles.delete(absPath);
      }
    } catch {
      // Keep the in-memory stale marker if freshness cannot be proven.
    }
  }
}

function isIndexControlFile(name: string): boolean {
  return name === '.gitignore' || name === 'index.ignore';
}

const MAX_HISTORY = 50;

function pushHistory(ctx: ServerContext, type: 'start' | 'progress' | 'complete' | 'error', message: string): void {
  ctx.indexing.history.push({ timestamp: new Date().toISOString(), type, message });
  if (ctx.indexing.history.length > MAX_HISTORY) {
    ctx.indexing.history = ctx.indexing.history.slice(-MAX_HISTORY);
  }
}

/** Wrap an indexFromPath call with status tracking */
async function trackedIndex(
  ctx: ServerContext,
  project: string,
  dirPath: string,
  opts?: { force?: boolean; label?: string },
): Promise<{ totalChunks: number; repos: Array<{ name: string }>; crossRepoEdges: number; indexDurationMs: number }> {
  const label = opts?.label ?? 'index';

  ctx.indexing.status = 'indexing';
  ctx.indexing.phase = 'starting';
  ctx.indexing.message = `Starting ${label}...`;
  ctx.indexing.percent = 0;
  ctx.indexing.startedAt = Date.now();
  ctx.indexing.error = null;
  pushHistory(ctx, 'start', `${label}: started for "${project}" at ${dirPath}`);
  log(ctx, `[${label}] started for "${project}" at ${dirPath}`);

  try {
    const stats = await indexFromPath(project, dirPath, {
      force: opts?.force,
      onProgress: (m) => {
        ctx.indexing.message = m;
        log(ctx, `[${label}] ${m}`);
      },
      onDetailedProgress: (p) => {
        ctx.indexing.phase = p.phase;
        ctx.indexing.percent = p.percent;
        ctx.indexing.message = p.message;
        const details = [
          p.reposProcessed !== undefined && p.reposTotal !== undefined ? `repos ${p.reposProcessed}/${p.reposTotal}` : null,
          p.chunksProcessed !== undefined && p.chunksTotal !== undefined ? `chunks ${p.chunksProcessed}/${p.chunksTotal}` : null,
          p.etaSeconds !== undefined ? `eta ${p.etaSeconds}s` : null,
        ].filter(Boolean).join(', ');
        log(ctx, `[${label}] progress ${p.percent}% phase=${p.phase}${details ? ` (${details})` : ''}: ${p.message}`);
      },
    });

    ctx.indexReady = true;
    ctx.indexing.status = 'idle';
    ctx.indexing.phase = null;
    ctx.indexing.percent = 100;
    ctx.indexing.lastSuccess = new Date().toISOString();
    ctx.indexing.lastDurationMs = stats.indexDurationMs;
    ctx.indexing.message = `Completed: ${stats.totalChunks} chunks, ${stats.repos.length} repos in ${Math.round(stats.indexDurationMs / 1000)}s`;
    pushHistory(ctx, 'complete', ctx.indexing.message);
    log(ctx, `[${label}] ${ctx.indexing.message}`);
    await startFileWatcher(ctx);
    if (!ctx.watchDrainRunning && (ctx.pendingWatchFiles.size > 0 || ctx.watchFollowUpNeeded)) {
      log(ctx, `[${label}] watcher has ${ctx.pendingWatchFiles.size} pending path(s), scheduling follow-up drain`);
      scheduleWatchDrain(ctx, 0);
    }

    return stats;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.indexing.status = 'error';
    ctx.indexing.error = msg;
    ctx.indexing.message = `Failed: ${msg}`;
    pushHistory(ctx, 'error', msg);
    log(ctx, `[${label}] failed`, err);
    throw err;
  }
}

async function startManualIndex(ctx: ServerContext): Promise<{ started: boolean; message: string }> {
  if (ctx.indexReady) {
    return { started: false, message: `Index is already initialized for "${ctx.projectName}". Use index_status to inspect it.` };
  }
  if (!ctx.initialIndexCheckDone) {
    return { started: false, message: `Still checking whether "${ctx.projectName}" already has an index. Call index_status, then retry index_start if it remains uninitialized.` };
  }
  if (ctx.indexing.status === 'indexing') {
    return { started: false, message: `Indexing is already in progress (phase: ${ctx.indexing.phase ?? 'starting'}). Use index_status to monitor progress.` };
  }
  if (!ctx.directoryPath) {
    return { started: false, message: `Cannot start indexing for "${ctx.projectName}": no project directory is configured for this MCP server.` };
  }

  ctx.autoIndexTask = trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'manual-index' })
    .then(() => undefined)
    .catch((err) => {
      log(ctx, '[manual-index] failed', err);
    });

  return { started: true, message: `Indexing started for "${ctx.projectName}" at ${ctx.directoryPath}. Use index_status to monitor progress.` };
}

async function initializeExistingIndex(ctx: ServerContext): Promise<void> {
  try {
    const kbPath = getKnowledgeBasePath(ctx.projectName);
    const hasLanceDB = existsSync(join(kbPath, 'lancedb'));
    const hasGraph = existsSync(join(kbPath, 'system_graph_v2.json'));

    if (hasLanceDB && hasGraph) {
      try {
        const stats = await new KnowledgeIndexer().getStats(ctx.projectName);
        const providerReady = stats.repos.length > 0 && stats.repos.every((repo) => repo.chunkCount > 0);
        const vectorReady = stats.totalChunks > 0;
        const embedded = stats.embeddingProvider !== 'pending' && stats.embeddingProvider !== 'unknown';

        if (providerReady && vectorReady && embedded) {
          ctx.indexReady = true;
          log(ctx, `[code-search-mcp] Index loaded for "${ctx.projectName}" (${stats.totalChunks} chunks, ${stats.embeddingProvider})`);
          if (ctx.directoryPath) {
            const freshness = new KnowledgeIndexer().checkFreshness(ctx.projectName, ctx.directoryPath);
            if (!freshness.stale) {
              await startFileWatcher(ctx);
              return;
            }

            ctx.indexing.message = `Existing index is stale: ${freshness.reason}. Refreshing in background...`;
            ctx.indexing.lastRefreshSummary = `stale: ${freshness.reason}`;
            log(ctx, `[code-search-mcp] Existing index is stale (${freshness.reason}); reposChecked=${freshness.reposChecked}, added=${freshness.added}, modified=${freshness.modified}, deleted=${freshness.deleted}, fingerprintMismatches=${freshness.fingerprintMismatches.join(',') || 'none'}; keeping stale results available and refreshing...`);
            await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'startup-refresh' });
            return;
          }
          return;
        }

        if (ctx.directoryPath && vectorReady && stats.embeddingProvider === 'pending') {
          ctx.indexReady = true;
          log(ctx, `[code-search-mcp] Existing index for "${ctx.projectName}" has pending embeddings; attempting automatic recovery...`);
          await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'startup-recovery' });
          return;
        }

        if (ctx.directoryPath && hasLanceDB && hasGraph) {
          log(ctx,
            `[code-search-mcp] Existing index for "${ctx.projectName}" is incomplete ` +
            `(chunks=${stats.totalChunks}, provider=${stats.embeddingProvider || 'unknown'}). Attempting repair refresh...`,
          );
          await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'startup-repair' });
          return;
        }

        log(ctx,
          `[code-search-mcp] Existing index for "${ctx.projectName}" is incomplete ` +
          `(chunks=${stats.totalChunks}, provider=${stats.embeddingProvider || 'unknown'}). Waiting for manual index_start.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(ctx, `[code-search-mcp] Existing index could not be opened (${msg}). Waiting for manual index_start.`, err);
      }
    }

    if (!ctx.directoryPath) {
      ctx.indexing.status = 'uninitialized';
      ctx.indexing.message = 'No existing index found and no directory path is configured. Configure a local project path before running index_start.';
      log(ctx, `[code-search-mcp] No index found and no directory path — index_start cannot run`);
      return;
    }

    ctx.indexing.status = 'uninitialized';
    ctx.indexing.phase = null;
    ctx.indexing.percent = 0;
    ctx.indexing.message = `No existing index found. Run index_start or the /index prompt to index ${ctx.directoryPath}.`;
    log(ctx, `[code-search-mcp] No index found for "${ctx.projectName}". Waiting for manual index_start.`);
  } catch (err) {
    ctx.indexing.status = 'error';
    ctx.indexing.error = err instanceof Error ? err.message : String(err);
    ctx.indexing.message = `Index initialization failed: ${ctx.indexing.error}`;
    log(ctx, `[code-search-mcp] Index initialization failed`, err);
  } finally {
    ctx.initialIndexCheckDone = true;
  }
}
