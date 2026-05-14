/**
 * Profile tools — repo profiles, repo listing.
 */

import type { ServerContext } from '../server.js';
import { loadAllProfiles, loadProfile } from '@esankhan3/anvil-knowledge-core';
import { discoverRepos } from '@esankhan3/anvil-knowledge-core';

export function registerProfileTools(opts?: { profilingEnabled?: boolean }) {
  const tools = [
    {
      name: 'list_repos',
      description: opts?.profilingEnabled === false
        ? 'List indexed repos. Profiling is disabled, so role/domain/description fields are unavailable.'
        : 'List all indexed repos with their role, domain, and description.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ];

  if (opts?.profilingEnabled === false) return tools;

  return [
    ...tools,
    {
      name: 'get_repo_profile',
      description: 'Get the LLM-generated profile for a repo — role, domain, tech stack, exposed/consumed endpoints.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['repo'],
      },
    },
  ];
}

export async function handleProfileTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!['list_repos', 'get_repo_profile'].includes(name)) return null;

  if (!ctx.indexReady) {
    return { content: [{ type: 'text', text: `Index not ready for "${ctx.projectName}". Run index_start or the /index prompt, then poll index_status until Ready is yes.` }] };
  }

  try {
    // imported at top

    if (name === 'get_repo_profile' && !ctx.profilingEnabled) {
      return { content: [{ type: 'text', text: 'Repo profiling is disabled (CODE_SEARCH_LLM_MODE=none), so get_repo_profile is not available.' }] };
    }

    if (name === 'list_repos') {
      const profiles = loadAllProfiles(ctx.projectName);
      if (profiles.length === 0) {
        // Fall back to discovering repos from directory
        if (ctx.directoryPath) {
          // imported at top
          const repos = discoverRepos(ctx.directoryPath);
          const text = repos.map(r => `- **${r.name}** (${r.language})`).join('\n');
          const reason = ctx.profilingEnabled
            ? 'not yet profiled'
            : 'profiling disabled: CODE_SEARCH_LLM_MODE=none';
          return { content: [{ type: 'text', text: `# Repos (${repos.length}, ${reason})\n\n${text}` }] };
        }
        return { content: [{ type: 'text', text: 'No repos found. Run reindex first.' }] };
      }

      const text = profiles.map(p =>
        `- **${p.name}** — ${p.role} | ${p.domain} | ${p.description}`
      ).join('\n');

      return { content: [{ type: 'text', text: `# Indexed Repos (${profiles.length})\n\n${text}` }] };
    }

    if (name === 'get_repo_profile') {
      const repo = args.repo as string;
      const profile = loadProfile(ctx.projectName, repo);
      if (!profile) {
        const reason = ctx.profilingEnabled
          ? 'Run reindex to generate profiles.'
          : 'Profiling is disabled (CODE_SEARCH_LLM_MODE=none).';
        return { content: [{ type: 'text', text: `No profile found for "${repo}". ${reason}` }] };
      }

      const lines = [
        `# ${profile.name}`,
        '',
        `**Role:** ${profile.role}`,
        `**Domain:** ${profile.domain}`,
        `**Description:** ${profile.description}`,
        `**Technologies:** ${profile.technologies.join(', ')}`,
        `**Entry points:** ${profile.entryPoints.join(', ')}`,
        '',
      ];

      if (profile.exposes.length > 0) {
        lines.push('## Exposes');
        for (const e of profile.exposes) {
          lines.push(`- **${e.type}:** \`${e.identifier}\` — ${e.description}`);
        }
        lines.push('');
      }

      if (profile.consumes.length > 0) {
        lines.push('## Consumes');
        for (const c of profile.consumes) {
          lines.push(`- **${c.type}:** \`${c.identifier}\` — ${c.description}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Profile tool error: ${msg}` }] };
  }
}
