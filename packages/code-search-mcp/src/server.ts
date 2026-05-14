/**
 * MCP Server — registers tools and resources, handles lifecycle.
 * Supports stdio (default) and HTTP transports with auth.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { FSWatcher } from 'chokidar';

import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerGraphTools, handleGraphTool } from './tools/graph.js';
import { registerProfileTools, handleProfileTool } from './tools/profile.js';
import { registerIndexTools, handleIndexTool } from './tools/index-tools';
import { registerResources, handleResource } from './resources/resources';
import { getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';
import { indexFromPath } from '@esankhan3/anvil-knowledge-core';
import { KnowledgeIndexer } from '@esankhan3/anvil-knowledge-core';
import { discoverRepos, isIndexableFile, ensureIndexIgnore } from '@esankhan3/anvil-knowledge-core';
import { loadServerConfig, type ServerConfig } from './core/env-config.js';
import { startHttpTransport } from './transports/http-transport.js';

// State shared across tools
export interface IndexingState {
  status: 'idle' | 'indexing' | 'error';
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
  startedAt: number;
  indexing: IndexingState;
  logFile: string | null;
  autoIndexTask: Promise<void> | null;
  watcher: FSWatcher | null;
  pendingWatchFiles: Set<string>;
  watchTimer: NodeJS.Timeout | null;
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
    { capabilities: { tools: {}, resources: {} } },
  );

  const allTools = [
    ...registerSearchTools(),
    ...registerGraphTools(),
    ...registerProfileTools(),
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

  const allResources = registerResources(ctx);

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: allResources,
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
    startedAt: Date.now(),
    logFile: initLogFile(projectName),
    autoIndexTask: null,
    watcher: null,
    pendingWatchFiles: new Set(),
    watchTimer: null,
    indexing: {
      status: 'idle',
      phase: null,
      message: null,
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

  // --- Auto-index in the background ---
  // MCP clients expect initialization to complete quickly. Full embedding jobs
  // can take minutes, so serve immediately and expose progress via index_status.
  ctx.autoIndexTask = autoIndex(ctx).catch((err) => {
    log(ctx, `[code-search-mcp] Background auto-index task failed`, err);
  });

  await startFileWatcher(ctx);

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

        const stats = await trackedIndex(ctx, project, dirPath, {
          force: body.force,
          label: 'admin-index',
        });

        ctx.projectName = project;
        ctx.directoryPath = dirPath;
        ctx.logFile = initLogFile(project);

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
    ignored: /(^|[\\/])(\.git|node_modules|dist|build|\.anvil|\.opencode)([\\/]|$)/,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  ctx.watcher = watcher;

  const onChange = async (path: string) => {
    const absPath = resolve(path);
    if (!isPotentialIndexPath(ctx, absPath)) {
      log(ctx, `[watcher] ignored non-indexable path: ${absPath}`);
      return;
    }
    if (!watchPathNeedsRefresh(ctx, absPath)) {
      log(ctx, `[watcher] ignored unchanged path event: ${absPath}`);
      return;
    }
    const before = ctx.pendingWatchFiles.size;
    ctx.pendingWatchFiles.add(absPath);
    ctx.indexing.pendingFiles = ctx.pendingWatchFiles.size;
    log(ctx, `[watcher] queued path (${ctx.indexing.pendingFiles} pending): ${absPath}`);
    await markPendingFilesDirty(ctx);
    if (ctx.watchTimer) clearTimeout(ctx.watchTimer);
    if (before === 0) log(ctx, `[watcher] debounce started (${debounceMs}ms)`);
    ctx.watchTimer = setTimeout(() => {
      void flushWatchedChanges(ctx);
    }, debounceMs);
  };

  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', onChange);
  watcher.on('ready', () => log(ctx, `[watcher] ready for ${ctx.directoryPath}`));
  watcher.on('error', (err) => log(ctx, '[watcher] error', err));
  log(ctx, `[code-search-mcp] File watcher enabled at ${ctx.directoryPath} (debounce ${debounceMs}ms)`);
}

function isPotentialIndexPath(ctx: ServerContext, absPath: string): boolean {
  if (!ctx.directoryPath) return false;
  const name = basename(absPath);
  if (name === '.gitignore' || name === 'index.ignore') return true;
  try {
    return existsSync(absPath) && isIndexableFile(findRepoForPath(ctx, absPath)?.path ?? ctx.directoryPath, absPath);
  } catch {
    return true;
  }
}

function watchPathNeedsRefresh(ctx: ServerContext, absPath: string): boolean {
  const name = basename(absPath);
  if (name === '.gitignore' || name === 'index.ignore') return true;
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
  try {
    const repos = discoverRepos(ctx.directoryPath);
    return repos
      .filter((repo) => absPath.startsWith(repo.path))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  } catch {
    return null;
  }
}

async function markPendingFilesDirty(ctx: ServerContext): Promise<void> {
  const files = filesForRepos(ctx, [...ctx.pendingWatchFiles]);
  if (files.length === 0) return;
  try {
    const marked = await new KnowledgeIndexer().markFilesDirty(ctx.projectName, files, true);
    log(ctx, `[watcher] marked ${marked} chunk(s) dirty across ${files.length} file(s)`);
  } catch (err) {
    log(ctx, '[watcher] failed to mark files dirty', err);
  }
}

function filesForRepos(ctx: ServerContext, paths: string[]): Array<{ repoName: string; filePath: string }> {
  if (!ctx.directoryPath) return [];
  let repos: Array<{ name: string; path: string; language: string }> = [];
  try {
    repos = discoverRepos(ctx.directoryPath);
  } catch {
    return [];
  }
  const result: Array<{ repoName: string; filePath: string }> = [];
  for (const absPath of paths) {
    const repo = repos
      .filter((candidate) => absPath.startsWith(candidate.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!repo) continue;
    result.push({ repoName: repo.name, filePath: relative(repo.path, absPath) });
  }
  return result;
}

async function flushWatchedChanges(ctx: ServerContext): Promise<void> {
  if (!ctx.directoryPath) {
    log(ctx, '[watcher] flush skipped: no directory path');
    return;
  }
  if (ctx.indexing.status === 'indexing') {
    log(ctx, `[watcher] flush delayed: index already running (${ctx.indexing.phase ?? 'unknown phase'})`);
    if (ctx.watchTimer) clearTimeout(ctx.watchTimer);
    ctx.watchTimer = setTimeout(() => {
      void flushWatchedChanges(ctx);
    }, ctx.indexing.debounceMs);
    return;
  }
  const count = ctx.pendingWatchFiles.size;
  if (count === 0) {
    log(ctx, '[watcher] flush skipped: no pending files');
    return;
  }
  const pending = [...ctx.pendingWatchFiles];
  ctx.pendingWatchFiles.clear();
  ctx.indexing.pendingFiles = 0;
  try {
    log(ctx, `[watcher] flushing ${count} path(s): ${pending.slice(0, 12).join(', ')}${pending.length > 12 ? `, ... ${pending.length - 12} more` : ''}`);
    await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'watch-reindex' });
    ctx.indexing.lastRefresh = new Date().toISOString();
    ctx.indexing.lastRefreshSummary = `${count} watched path(s)`;
    log(ctx, `[watcher] refresh complete for ${count} path(s)`);
  } catch (err) {
    log(ctx, '[watcher] reindex failed', err);
  }
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

async function autoIndex(ctx: ServerContext): Promise<void> {
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
            if (!freshness.stale) return;

            ctx.indexing.message = `Existing index is stale: ${freshness.reason}. Refreshing in background...`;
            ctx.indexing.lastRefreshSummary = `stale: ${freshness.reason}`;
            log(ctx, `[code-search-mcp] Existing index is stale (${freshness.reason}); reposChecked=${freshness.reposChecked}, added=${freshness.added}, modified=${freshness.modified}, deleted=${freshness.deleted}, fingerprintMismatches=${freshness.fingerprintMismatches.join(',') || 'none'}; keeping stale results available and refreshing...`);
            if (freshness.files.length > 0) {
              try {
                const marked = await new KnowledgeIndexer().markFilesDirty(ctx.projectName, freshness.files, true);
                log(ctx, `[code-search-mcp] Startup freshness marked ${marked} chunk(s) dirty across ${freshness.files.length} file(s)`);
              } catch (err) {
                log(ctx, '[code-search-mcp] Startup freshness dirty marking failed', err);
              }
            }
            await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'startup-refresh' });
            return;
          }
          return;
        }

        log(ctx,
          `[code-search-mcp] Existing index for "${ctx.projectName}" is incomplete ` +
          `(chunks=${stats.totalChunks}, provider=${stats.embeddingProvider || 'unknown'}). Rebuilding...`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(ctx, `[code-search-mcp] Existing index could not be opened (${msg}). Rebuilding...`, err);
      }
    }

    if (!ctx.directoryPath) {
      log(ctx, `[code-search-mcp] No index found and no directory path — tools will return empty results`);
      return;
    }

    // Build KB + Embed
    log(ctx, `[code-search-mcp] No index found — building from ${ctx.directoryPath}...`);
    await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-index' });
    log(ctx, `[code-search-mcp] Index ready.`);
  } catch (err) {
    log(ctx, `[code-search-mcp] Auto-index failed`, err);
  }
}
