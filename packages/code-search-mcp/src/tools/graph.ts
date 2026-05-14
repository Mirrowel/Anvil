/**
 * Graph tools — AST graph queries, callers, dependencies, impact analysis.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import { getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';

function normalizeGraphPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function registerGraphTools() {
  return [
    {
      name: 'get_repo_graph',
      description: 'Summarize the AST knowledge graph for one indexed repo in the current project. Shows graph size and a sample of discovered entities such as functions, classes, methods, types, imports, and related symbols. Use this to understand what the index knows about a repo before asking caller, dependency, or impact questions. Requires the index to be ready. This tool expects a repo name, not a filesystem path; the MCP already knows the current project folder.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Required. Indexed repo name exactly as shown by list_repos or index_status. Do not provide a local path for the current project.' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_cross_repo_edges',
      description: 'List cross-repo relationships discovered in the current indexed project. Edges may come from shared dependencies, imports, HTTP routes, Kafka topics, gRPC/protobuf, database tables, environment variables, workspace links, Docker or Kubernetes config, and inferred service relationships. Use this to understand how repos depend on or communicate with each other. Requires the index to be ready. No path input is needed because the MCP is already scoped to the current project.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Optional. Indexed repo name to filter for edges where this repo is the source or target. Omit to list cross-repo edges across the whole current project.' },
        },
      },
    },
    {
      name: 'find_callers',
      description: 'Find functions, methods, or graph entities that call or reference a target function-like entity in the current indexed project. Uses incoming edges from the AST/system graph, so it can surface callers across repos when the graph contains those relationships. Best for answering "who calls this?" before changing or deleting code. Requires the index to be ready. Results are graph node identifiers, not full source snippets; use search_code afterward for implementation context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', description: 'Required. Function, method, class member, or symbol name to match. Partial names are allowed but may match multiple entities; use a more specific name if results are broad.' },
          repo: { type: 'string', description: 'Optional. Indexed repo name to limit the target entity search. Omit to find matching targets across all repos in the current project.' },
        },
        required: ['function'],
      },
    },
    {
      name: 'find_dependencies',
      description: 'Find what a target function-like entity calls, imports, references, or otherwise depends on in the current indexed project. Uses outgoing edges from the AST/system graph and can include cross-repo dependencies when present. Best for understanding what code must stay available for a function before refactoring it. Requires the index to be ready. Results are graph node identifiers; use search_code for source snippets.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', description: 'Required. Function, method, class member, or symbol name to match. Partial names are allowed but may match multiple entities.' },
          repo: { type: 'string', description: 'Optional. Indexed repo name to limit the target entity search. Omit to search all repos in the current project.' },
        },
        required: ['function'],
      },
    },
    {
      name: 'impact_analysis',
      description: 'Analyze what may be affected by changing a file or a specific entity in the current indexed project. Finds indexed entities in the file, incoming dependent edges, and affected repos, including cross-repo dependents when graph data exists. Use before refactors, API changes, deleting code, or modifying shared types/config. Requires the index to be ready. Expects a repo name and a repo-relative file path, not an absolute local path; the MCP already knows the project folder.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file: { type: 'string', description: 'Required. File path relative to the repo root, using forward slashes when possible, for example src/server.ts. Do not pass an absolute filesystem path for the current project.' },
          entity: { type: 'string', description: 'Optional. Specific function, method, class, type, or symbol name within the file. Omit to analyze all indexed entities in the file.' },
          repo: { type: 'string', description: 'Required. Indexed repo name that contains the file, exactly as shown by list_repos or index_status.' },
        },
        required: ['file', 'repo'],
      },
    },
  ];
}

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!['get_repo_graph', 'get_cross_repo_edges', 'find_callers', 'find_dependencies', 'impact_analysis'].includes(name)) return null;

  if (!ctx.indexReady) {
    return { content: [{ type: 'text', text: `Index not ready for "${ctx.projectName}". Run index_start or the /index prompt, then poll index_status until Ready is yes.` }] };
  }

  try {
    // getKnowledgeBasePath imported at top
    const kbPath = getKnowledgeBasePath(ctx.projectName);

    if (name === 'get_repo_graph') {
      const repo = args.repo as string;
      const graphPath = join(kbPath, repo, 'graph.json');
      if (!existsSync(graphPath)) {
        return { content: [{ type: 'text', text: `No graph found for repo "${repo}"` }] };
      }
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
      const summary = `# ${repo} AST Graph\n\n- **Nodes:** ${graph.nodes?.length ?? 0}\n- **Edges:** ${graph.links?.length ?? 0}\n\n## Entities\n${(graph.nodes ?? []).slice(0, 50).map((n: any) => `- \`${n.id}\` (${n.type})`).join('\n')}\n\n${graph.nodes?.length > 50 ? `... and ${graph.nodes.length - 50} more` : ''}`;
      return { content: [{ type: 'text', text: summary }] };
    }

    if (name === 'get_cross_repo_edges') {
      const sysGraphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(sysGraphPath)) {
        return { content: [{ type: 'text', text: 'No system graph found. Build KB first.' }] };
      }
      const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
      const edges = sysGraph.edges ?? [];
      const repo = args.repo as string | undefined;

      const relevant = repo
        ? edges.filter((e: any) => (e.source ?? '').startsWith(repo + '::') || (e.target ?? '').startsWith(repo + '::'))
        : edges;

      const crossRepo = relevant.filter((e: any) => {
        const src = (e.source ?? '').split('::')[0];
        const tgt = (e.target ?? '').split('::')[0];
        return src && tgt && src !== tgt;
      });

      if (crossRepo.length === 0) {
        return { content: [{ type: 'text', text: repo ? `No cross-repo edges found for "${repo}"` : 'No cross-repo edges found' }] };
      }

      const text = crossRepo.slice(0, 50).map((e: any) => {
        const attrs = e.attributes ?? {};
        return `- ${(e.source ?? '').split('::')[0]} → ${(e.target ?? '').split('::')[0]} (${attrs.relation ?? attrs.type ?? 'edge'})`;
      }).join('\n');

      return { content: [{ type: 'text', text: `# Cross-Repo Edges${repo ? ` for ${repo}` : ''}\n\n${crossRepo.length} edges found:\n\n${text}${crossRepo.length > 50 ? `\n\n... and ${crossRepo.length - 50} more` : ''}` }] };
    }

    if (name === 'find_callers' || name === 'find_dependencies') {
      const funcName = args.function as string;
      const repoFilter = args.repo as string | undefined;
      const sysGraphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(sysGraphPath)) {
        return { content: [{ type: 'text', text: 'No system graph found.' }] };
      }
      const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
      const edges = sysGraph.edges ?? [];

      // Find nodes matching the function name
      const matchingNodes = (sysGraph.nodes ?? []).filter((n: any) => {
        const label = n.attributes?.label ?? n.key ?? '';
        const matchesName = label.includes(funcName) || (n.key ?? '').includes(funcName);
        const matchesRepo = !repoFilter || (n.key ?? '').startsWith(repoFilter + '::');
        return matchesName && matchesRepo;
      });

      if (matchingNodes.length === 0) {
        return { content: [{ type: 'text', text: `No entity found matching "${funcName}"${repoFilter ? ` in ${repoFilter}` : ''}` }] };
      }

      const nodeKeys = new Set(matchingNodes.map((n: any) => n.key));
      let results: any[];

      if (name === 'find_callers') {
        // Incoming edges — who calls this function?
        results = edges.filter((e: any) => nodeKeys.has(e.target)).map((e: any) => e.source);
      } else {
        // Outgoing edges — what does this function call?
        results = edges.filter((e: any) => nodeKeys.has(e.source)).map((e: any) => e.target);
      }

      const unique = [...new Set(results)].slice(0, 30);
      const direction = name === 'find_callers' ? 'Callers of' : 'Dependencies of';

      return { content: [{ type: 'text', text: `# ${direction} "${funcName}"\n\n${unique.length} found:\n${unique.map((r: string) => `- \`${r}\``).join('\n')}` }] };
    }

    if (name === 'impact_analysis') {
      const file = args.file as string;
      const repo = args.repo as string;
      const entity = args.entity as string | undefined;

      const sysGraphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(sysGraphPath)) {
        return { content: [{ type: 'text', text: 'No system graph found.' }] };
      }
      const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
      const edges = sysGraph.edges ?? [];
      const nodes = sysGraph.nodes ?? [];

      // Find all nodes in this file
      const normalizedFile = normalizeGraphPath(file);
      const fileNodes = nodes.filter((n: any) => {
        const key = n.key ?? '';
        const attrs = n.attributes ?? {};
        const nodeRepo = attrs.repo ?? key.split('::')[0];
        const nodeFile = normalizeGraphPath(attrs.file ?? key.slice(`${repo}::`.length).split('::')[0] ?? '');
        const matchesFile = nodeRepo === repo && nodeFile === normalizedFile;
        const matchesEntity = !entity || key.includes(entity) || (attrs.label ?? '').includes(entity);
        return matchesFile && matchesEntity;
      });

      const nodeKeys = new Set(fileNodes.map((n: any) => n.key));

      // Find all incoming edges (who depends on entities in this file)
      const dependents = edges.filter((e: any) => nodeKeys.has(e.target) && !nodeKeys.has(e.source));
      const dependentRepos = new Set(dependents.map((e: any) => (e.source ?? '').split('::')[0]));

      const text = [
        `# Impact Analysis: ${repo}/${file}${entity ? `::${entity}` : ''}`,
        '',
        `## Entities in scope: ${fileNodes.length}`,
        ...fileNodes.slice(0, 20).map((n: any) => `- \`${n.key}\``),
        '',
        `## Dependents: ${dependents.length} edges from ${dependentRepos.size} repos`,
        ...dependents.slice(0, 30).map((e: any) => `- \`${e.source}\` → \`${e.target}\` (${(e.attributes ?? {}).relation ?? 'edge'})`),
        dependents.length > 30 ? `\n... and ${dependents.length - 30} more` : '',
        '',
        `## Affected repos: ${[...dependentRepos].join(', ') || 'none'}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Graph tool error: ${msg}` }] };
  }
}
