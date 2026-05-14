/**
 * Search tools — hybrid, semantic, and keyword search.
 */

import type { ServerContext } from '../server.js';
import { getRetriever } from '@esankhan3/anvil-knowledge-core';

export function registerSearchTools() {
  return [
    {
      name: 'search_code',
      description: 'Primary/default code discovery tool for agents working in this project. Use this frequently before editing or explaining code unless a plain local grep is clearly better for a tiny exact-text lookup in known files. Searches indexed code across all repos using hybrid retrieval: semantic vectors for meaning, BM25 for exact tokens, graph expansion for related callers/callees/types, and reranking for relevance. Best overall for natural-language questions, code identifiers, architecture discovery, feature tracing, and cross-repo investigations. Requires the index to be ready; if not, call index_status and then index_start. Returns ranked code chunks with repo, file path, start line, score, retrieval source, and snippet content. The MCP already knows the current project path; do not provide a filesystem path unless you are intentionally running a separately configured MCP for another folder.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Required. Natural-language question, code concept, identifier, symbol name, error text, route, topic, table, or other search text. Works with both natural language and exact terms. Do not include a local filesystem path just to indicate the current project; the MCP is already scoped to it.' },
          maxResults: { type: 'number', description: 'Optional. Maximum ranked chunks to return. Defaults to 10. Increase for broad investigations; keep small for focused lookups.' },
          repos: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict results to specific indexed repo names inside the current project. Omit to search every indexed repo.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_semantic',
      description: 'Semantic-only code search for the current indexed project. Uses vector similarity to find code related by meaning, intent, and paraphrase rather than exact tokens. Best for conceptual questions such as how a feature works, where behavior is implemented, or what code is related to a domain concept when you do not know the exact names. It can miss exact identifiers that have little semantic context. Requires the index to be ready and returns ranked code chunks. Prefer search_code when you are unsure because hybrid search combines semantic, exact, graph, and reranking signals.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Required. Natural-language description of the behavior, feature, architecture area, or intent to find. Do not pass the current project path; it is implicit.' },
          maxResults: { type: 'number', description: 'Optional. Maximum ranked chunks to return. Defaults to 10.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_exact',
      description: 'Exact keyword code search for the current indexed project. Uses BM25 lexical matching only; it matches literal terms and does not understand natural-language intent, synonyms, or paraphrases. Best for exact function names, class names, constants, file names, route strings, error messages, log text, config keys, and other literal tokens. Requires the index to be ready and returns ranked code chunks. Prefer search_code for general discovery, natural-language questions, or mixed natural-language plus identifier searches. Use local grep instead only when you need raw exact matches in specific known files or want exhaustive line-by-line matches rather than ranked chunks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Required. Exact keyword, identifier, file path fragment, string literal, error code, route, topic, or other token to match in indexed code. This is not for natural-language questions. Do not pass the current project path; it is implicit.' },
          maxResults: { type: 'number', description: 'Optional. Maximum ranked chunks to return. Defaults to 10.' },
        },
        required: ['query'],
      },
    },
  ];
}

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!['search_code', 'search_semantic', 'search_exact'].includes(name)) return null;

  if (!ctx.indexReady) {
    const state = ctx.indexing;
    const details = [
      `Index not ready for "${ctx.projectName}".`,
      `status: ${state.status}`,
      state.phase ? `phase: ${state.phase}` : null,
      `percent: ${state.percent}`,
      state.message ? `message: ${state.message}` : null,
      state.pendingFiles ? `pending watcher files: ${state.pendingFiles}` : null,
      state.error ? `last error: ${state.error}` : null,
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text: `${details}\nCall index_status first if you have not already. If Ready is no and Indexing is not running, call index_start with no arguments or use the /index prompt; the MCP already knows the current project path. Then poll index_status until Ready is yes and Indexing is idle, or stop if status becomes error.` }] };
  }

  try {
    // getRetriever imported at top
    const retriever = await getRetriever(ctx.projectName);

    const query = args.query as string;
    const maxResults = (args.maxResults as number) || 10;
    const repos = args.repos as string[] | undefined;

    const modeMap: Record<string, string> = {
      search_code: 'vector+bm25+graph',
      search_semantic: 'vector',
      search_exact: 'bm25',
    };

    const result = await retriever.retrieve(query, {
      maxChunks: maxResults,
      repoFilter: repos,
      mode: modeMap[name] as any,
    });

    if (result.chunks.length === 0) {
      return { content: [{ type: 'text', text: `No results found for "${query}"` }] };
    }

    const text = result.chunks.map((sc, i) => {
      const c = sc.chunk;
      const stale = c.dirty ? ' — POSSIBLY STALE: file changed; re-index pending' : '';
      return `### ${i + 1}. ${c.repoName}/${c.filePath}:${c.startLine} (score: ${sc.score.toFixed(3)}, source: ${sc.source}${stale})\n\`\`\`${c.language}\n${c.content}\n\`\`\``;
    }).join('\n\n');

    const warning = result.graphContext.startsWith('Warning:') ? `${result.graphContext.split('\n\n')[0]}\n\n` : '';
    const watcherWarning = ctx.staleWatchFiles.size > 0 ? `Warning: ${ctx.staleWatchFiles.size} watched file(s) changed and may not be indexed yet.\n\n` : '';
    return { content: [{ type: 'text', text: `${warning}${watcherWarning}Found ${result.chunks.length} results for "${query}" (${result.totalTokens} tokens):\n\n${text}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Search failed: ${msg}` }] };
  }
}
