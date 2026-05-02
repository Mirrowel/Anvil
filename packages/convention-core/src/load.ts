/**
 * Convention loaders — read what `extractConventions` produced from disk.
 *
 * Two surfaces:
 *  - `loadConventions(paths, project)` — markdown for prompt injection.
 *    Includes a global preamble at `<conventionsDir>/global.md` if present.
 *  - `loadRules(paths, project)` — structured ConventionRule[] for the
 *    review prepass. Reads the canonical `rules.json` first; falls back
 *    to legacy paths during the migration window.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConventionPaths } from './paths.js';
import type { ConventionRule } from './rules/types.js';

const MAX_SIZE = 20 * 1024; // 20KB cap, mirrors the cli loader

export class ConventionFileTooLargeError extends Error {
  constructor(public readonly path: string, public readonly size: number) {
    super(`Convention file exceeds 20KB limit: ${path} (${size} bytes)`);
    this.name = 'ConventionFileTooLargeError';
  }
}

/**
 * Load convention markdown for a project.
 * Concatenates global.md (if present) with `<project>/conventions.md`.
 * Returns empty string when nothing exists. Throws if any file exceeds 20KB.
 */
export async function loadConventions(paths: ConventionPaths, project: string): Promise<string> {
  const parts: string[] = [];

  const globalPath = join(paths.conventionsDir, 'global.md');
  if (existsSync(globalPath)) {
    const size = statSync(globalPath).size;
    if (size > MAX_SIZE) throw new ConventionFileTooLargeError(globalPath, size);
    parts.push(readFileSync(globalPath, 'utf-8'));
  }

  const projectPath = join(paths.conventionsDir, project, 'conventions.md');
  if (existsSync(projectPath)) {
    const size = statSync(projectPath).size;
    if (size > MAX_SIZE) throw new ConventionFileTooLargeError(projectPath, size);
    parts.push(readFileSync(projectPath, 'utf-8'));
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Load structured convention rules for a project. Returns [] when none exist.
 *
 * Resolution order (first non-empty wins):
 *  1. `<conventionsDir>/<project>/rules.json` — canonical
 *  2. `<rulesDir>/<project>/generated.json` — legacy dashboard path
 *
 * Step 2 is read-fallback only; new writes go to (1).
 */
export function loadRules(paths: ConventionPaths, project: string): ConventionRule[] {
  const canonical = join(paths.conventionsDir, project, 'rules.json');
  const legacy = join(paths.rulesDir, project, 'generated.json');

  const tryRead = (path: string): ConventionRule[] | null => {
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { rules?: ConventionRule[] };
      return Array.isArray(raw.rules) ? raw.rules : [];
    } catch {
      return null;
    }
  };

  return tryRead(canonical) ?? tryRead(legacy) ?? [];
}
