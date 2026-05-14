/**
 * Index management tools — status, reindex, and dynamic index_path.
 */

import type { ServerContext } from '../server.js';
import { KnowledgeIndexer } from '@esankhan3/anvil-knowledge-core';

const TOOL_NAMES = ['index_status', 'index_start'];

export function registerIndexTools() {
  return [
    {
      name: 'index_status',
      description: 'Report whether the current MCP project index is ready and whether indexing is idle, running, or errored. Shows progress, phase, messages, watcher state, stale-file warnings, log file path, chunk count, embedding provider, last indexed time, and indexed repos. Call this before search, graph, profile, or resource tools if results are missing or the index may not be ready. No input is expected; the MCP already knows the current project path.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'index_start',
      description: 'Start indexing the current MCP project path configured when this server was launched. Use this when index_status says Ready is no, when the index is stale, or when search/graph/profile tools say the index is not ready. This tool does not accept a path; the current folder/project is already known by the MCP. To index a different folder, start or configure the MCP for that folder instead. After calling, poll index_status about every 30 seconds until Ready is yes and Indexing is idle, or stop if status becomes error.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ];
}

export async function handleIndexTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!TOOL_NAMES.includes(name)) return null;

  try {
    if (name === 'index_status') {
      const indexer = new KnowledgeIndexer();
      const stats = ctx.indexReady
        ? await indexer.getStats(ctx.projectName)
        : { totalChunks: 0, embeddingProvider: 'n/a', lastIndexed: '', repos: [] };
      const manualHint = !ctx.indexReady && ctx.indexing.status !== 'indexing'
        ? 'Run `index_start` or the `/index` prompt to initialize indexing for this project.'
        : ctx.indexing.status === 'indexing'
          ? 'Indexing is running. Poll `index_status` until Ready is yes and Indexing is idle.'
          : 'Index is ready. Other code-search tools are available.';

      const lines = [
        `# Index Status: ${ctx.projectName}`,
        '',
        `- **Ready:** ${ctx.indexReady ? 'yes' : 'no'}`,
        `- **Indexing:** ${ctx.indexing.status}`,
        `- **Phase:** ${ctx.indexing.phase ?? 'n/a'}`,
        `- **Progress:** ${ctx.indexing.percent}%`,
        `- **Message:** ${ctx.indexing.message ?? 'n/a'}`,
        `- **Error:** ${ctx.indexing.error ?? 'n/a'}`,
        `- **Log file:** ${ctx.logFile ?? 'n/a'}`,
        `- **Watcher:** ${ctx.indexing.watcherEnabled ? `enabled (${ctx.indexing.debounceMs}ms debounce)` : 'disabled'}`,
        `- **Pending watched files:** ${ctx.indexing.pendingFiles}`,
        `- **Possibly stale watched files:** ${ctx.staleWatchFiles.size}`,
        `- **Watcher drain:** ${ctx.watchDrainRunning ? 'running' : ctx.watchFollowUpNeeded ? 'follow-up queued' : 'idle'}`,
        `- **Last watched refresh:** ${ctx.indexing.lastRefresh ?? 'never'}`,
        `- **Last watched summary:** ${ctx.indexing.lastRefreshSummary ?? 'n/a'}`,
        `- **Next step:** ${manualHint}`,
        '',
        `- **Chunks:** ${stats.totalChunks.toLocaleString()}`,
        `- **Embedding provider:** ${stats.embeddingProvider}`,
        `- **Last indexed:** ${stats.lastIndexed || 'never'}`,
        `- **Repos:** ${stats.repos.length}`,
        '',
        '## Repos',
        ...stats.repos.map(r => `- ${r.name}: ${r.chunkCount} chunks`),
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'index_start') {
      const result = await ctx.startIndexing();
      return {
        content: [{
          type: 'text',
          text: [
            result.message,
            result.started
              ? 'Indexing may take several minutes. Call index_status every ~30 seconds until Ready is yes and Indexing is idle.'
              : 'Call index_status for the current state.',
          ].join('\n'),
        }],
      };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Index tool error: ${msg}` }] };
  }
}
