/**
 * Ship-stage prompt helpers + parsers owned by core-pipeline.
 *
 * Both cli's `createShipStep` and the dashboard's ship Step factory use
 * these helpers. There's no `runShipStage` free function here —
 * orchestration lives in the Step factory itself, where it has access
 * to its consumer's state (cost ledger, gh-auth pre-check, etc.).
 */

export interface ShipPromptInput {
  feature: string;
  featureSlug: string;
  repoNames: readonly string[];
  workspaceDir: string;
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  baseBranch?: string;
}

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s"')]+\/pull\/\d+/g;
const SANDBOX_URL_LINE = /^SANDBOX_URL=(\S+)\s*$/m;

/**
 * Canonical ship user prompt — pushes the feature branch and opens a PR
 * per repo. Both cli and dashboard render this verbatim so shipping
 * behavior is byte-identical across consumers.
 */
export function buildShipUserPrompt(input: ShipPromptInput): string {
  const branch = `anvil/${input.featureSlug}`;
  const repoListStr = input.repoNames.length > 0 ? input.repoNames.join(', ') : '(workspace root)';
  const baseBranch = input.baseBranch ?? 'main';

  const prLabels = ['anvil'];
  const at = input.actionType ?? 'feature';
  if (at === 'bugfix' || at === 'fix') prLabels.push('bug');
  else if (at === 'spike' || at === 'review') prLabels.push(at);
  else prLabels.push('enhancement');
  const labelFlags = prLabels.map((l) => `--label "${l}"`).join(' ');

  return `Feature: "${input.feature}"
Repositories: ${repoListStr}

## Push feature branch + open PR

The code is on feature branch "${branch}". The build, lint, and tests have run.

For each repo with changes:
1. Run a final quick check: build and lint to confirm everything is clean.
2. If ANY errors remain, fix them before proceeding.
3. Stage and commit — \`git add -A && git commit -m "[anvil] ${input.feature}"\`. Skip if nothing to commit.
4. Push the feature branch — \`git push -u origin "${branch}"\`. REQUIRED.
5. Open a PR — \`gh pr create --base "${baseBranch}" --head "${branch}" ${labelFlags}\`.
   - If prior stages reported errors, mark the PR as DRAFT (\`--draft\`) with a "## Known Issues" section.
   - Otherwise create a regular PR.

Non-negotiable: every repo with a feature branch ends with a pushed branch and an open PR. Do NOT merge to ${baseBranch}.`;
}

/** Pull GitHub PR URLs out of the agent's output. */
export function extractPrUrls(output: string): string[] {
  if (!output) return [];
  const matches = output.match(PR_URL_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

/** Pull the SANDBOX_URL=<url> declaration from the agent's output. */
export function extractSandboxUrl(output: string): string | undefined {
  if (!output) return undefined;
  const match = output.match(SANDBOX_URL_LINE);
  return match?.[1];
}
