/**
 * Shared file-walking utilities extracted from chunker.ts.
 *
 * Provides: SOURCE_EXTENSIONS, SKIP_DIRS, walkDir, langFromExt, extractImports,
 *           NamedImportSpec, extractNamedImports
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import ignore from 'ignore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.php',
]);

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', '__pycache__',
]);

export const INDEX_IGNORE_FILE = 'index.ignore';

const DEFAULT_MAX_FILE_SIZE_BYTES = 2_000_000;

function maxFileSizeBytes(): number {
  const raw = Number.parseInt(process.env.CODE_SEARCH_MAX_FILE_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_SIZE_BYTES;
}

type IgnoreMatcher = ReturnType<typeof ignore>;

interface IndexIgnoreMatcher {
  ignored: IgnoreMatcher;
  whitelisted: IgnoreMatcher;
}

export interface IndexIgnoreDiagnostics {
  root: string;
  indexIgnorePath: string;
  indexIgnoreExists: boolean;
  gitIgnored: string[];
  indexIgnored: string[];
  indexWhitelisted: string[];
}

// ---------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------

export function langFromExt(ext: string): string {
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.php':
      return 'php';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Recursive directory walker
// ---------------------------------------------------------------------------

export function walkDir(dir: string, collected: string[]): void {
  const files: string[] = [];
  walkDirRaw(dir, files);
  const filtered = filterIndexableFiles(dir, files);
  collected.push(...filtered);
}

export function getIndexIgnoreDiagnostics(root: string, files: string[]): IndexIgnoreDiagnostics {
  const relFiles = files.map((file) => toRelPath(root, file));
  const gitIgnored = getGitIgnoredPaths(root, relFiles);
  const indexIgnorePath = join(root, INDEX_IGNORE_FILE);
  const indexIgnore = loadIndexIgnore(indexIgnorePath);
  const indexIgnored: string[] = [];
  const indexWhitelisted: string[] = [];

  for (const relPath of relFiles) {
    if (indexIgnore.ignored.ignores(relPath)) indexIgnored.push(relPath);
    if (indexIgnore.whitelisted.ignores(relPath)) indexWhitelisted.push(relPath);
  }

  return {
    root,
    indexIgnorePath,
    indexIgnoreExists: existsSync(indexIgnorePath),
    gitIgnored: [...gitIgnored].sort(),
    indexIgnored: indexIgnored.sort(),
    indexWhitelisted: indexWhitelisted.sort(),
  };
}

export function filterIndexableFiles(root: string, files: string[]): string[] {
  const relByAbs = new Map(files.map((file) => [file, toRelPath(root, file)]));
  const relFiles = [...relByAbs.values()];
  const gitIgnored = getGitIgnoredPaths(root, relFiles);
  const indexIgnore = loadIndexIgnore(join(root, INDEX_IGNORE_FILE));

  return files.filter((file) => {
    const relPath = relByAbs.get(file);
    if (!relPath) return false;

    let ignored = gitIgnored.has(relPath);
    if (indexIgnore.ignored.ignores(relPath)) ignored = true;
    if (indexIgnore.whitelisted.ignores(relPath)) ignored = false;
    return !ignored;
  });
}

export function isIndexableFile(root: string, file: string): boolean {
  return filterIndexableFiles(root, [file]).length === 1;
}

function walkDirRaw(dir: string, collected: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // permission error or similar — skip
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDirRaw(full, collected);
    } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry)) && stat.size <= maxFileSizeBytes()) {
      collected.push(full);
    }
  }
}

function getGitIgnoredPaths(root: string, relFiles: string[]): Set<string> {
  if (relFiles.length === 0) return new Set();
  try {
    const output = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root,
      input: relFiles.join('\n'),
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(output.split('\n').map((line: string) => normalizeRelPath(line)).filter(Boolean));
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    return new Set(stdout.split('\n').map((line: string) => normalizeRelPath(line)).filter(Boolean));
  }
}

function loadIndexIgnore(ignorePath: string): IndexIgnoreMatcher {
  const ignored = ignore();
  const whitelisted = ignore();
  if (!existsSync(ignorePath)) return { ignored, whitelisted };

  let contents: string;
  try {
    contents = readFileSync(ignorePath, 'utf-8');
  } catch {
    return { ignored, whitelisted };
  }

  ignored.add(contents);
  whitelisted.add(extractWhitelistPatterns(contents));
  return { ignored, whitelisted };
}

function extractWhitelistPatterns(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!') && !line.startsWith('!!'))
    .map((line) => line.slice(1))
    .filter(Boolean);
}

function toRelPath(root: string, file: string): string {
  return normalizeRelPath(relative(root, file));
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/** Extract import identifiers from lines of a file. */
export function extractImports(lines: string[], lang: string): string[] {
  const imports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (lang === 'typescript' || lang === 'javascript') {
      const m = trimmed.match(/^import\s+.*from\s+['"]([@\w/.-]+)['"]/);
      if (m) imports.push(m[1]);
    } else if (lang === 'python') {
      const m = trimmed.match(/^(?:from\s+([\w.]+)\s+)?import\s+([\w., ]+)/);
      if (m) imports.push(m[1] ?? m[2]);
    } else if (lang === 'go') {
      const m = trimmed.match(/^\s*"([^"]+)"/);
      if (m) imports.push(m[1]);
    } else if (lang === 'java') {
      const m = trimmed.match(/^import\s+([\w.]+);/);
      if (m) imports.push(m[1]);
    } else if (lang === 'rust') {
      const m = trimmed.match(/^use\s+([\w:]+)/);
      if (m) imports.push(m[1]);
    } else if (lang === 'php') {
      const m = trimmed.match(/^use\s+([\w\\]+)/);
      if (m) imports.push(m[1]);
    }
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Named import extraction (entity-level import edges)
// ---------------------------------------------------------------------------

export interface NamedImportSpec {
  specifier: string;   // module path (e.g., './models', '@scope/pkg')
  names: string[];     // imported names (e.g., ['Response', 'Request'])
}

export function extractNamedImports(lines: string[], lang: string): NamedImportSpec[] {
  const results: NamedImportSpec[] = [];
  const fullText = lines.join('\n');

  if (lang === 'typescript' || lang === 'javascript') {
    // import { Foo, Bar as Baz } from './module.js'
    const re = /^import\s+\{([^}]+)\}\s+from\s+['"]([@\w/.\-]+)['"]/gm;
    let m;
    while ((m = re.exec(fullText)) !== null) {
      const names = m[1].split(',').map(s => {
        // Handle 'Bar as Baz' -> take 'Bar' (original name)
        const parts = s.trim().split(/\s+as\s+/);
        return parts[0].trim();
      }).filter(Boolean);
      if (names.length > 0) results.push({ specifier: m[2], names });
    }
    // import DefaultName from './module.js' -> treat as single named import
    const defaultRe = /^import\s+([A-Z]\w*)\s+from\s+['"]([@\w/.\-]+)['"]/gm;
    while ((m = defaultRe.exec(fullText)) !== null) {
      results.push({ specifier: m[2], names: [m[1]] });
    }
  }

  if (lang === 'python') {
    // from .models import Response, Request
    // from package.module import Foo, Bar
    const re = /^from\s+([\w.]+)\s+import\s+(.+)$/gm;
    let m;
    while ((m = re.exec(fullText)) !== null) {
      const names = m[2].split(',').map(s => {
        const parts = s.trim().split(/\s+as\s+/);
        return parts[0].trim();
      }).filter(s => s && !s.startsWith('('));
      if (names.length > 0) results.push({ specifier: m[1], names });
    }
  }

  if (lang === 'go') {
    // Go imports are package-level. The "name" is the last segment of the path.
    // import "github.com/org/repo/handler" -> handler is the imported name
    // import alias "path/to/pkg" -> alias is the imported name
    for (const line of lines) {
      const trimmed = line.trim();
      // Aliased import: alias "path/to/pkg"
      const aliased = trimmed.match(/^\s*(\w+)\s+"([^"]+)"/);
      if (aliased) {
        results.push({ specifier: aliased[2], names: [aliased[1]] });
        continue;
      }
      // Regular import: "path/to/pkg"
      const regular = trimmed.match(/^\s*"([^"]+)"/);
      if (regular) {
        const lastSeg = regular[1].split('/').pop();
        if (lastSeg) results.push({ specifier: regular[1], names: [lastSeg] });
      }
    }
  }

  if (lang === 'php') {
    // use App\Models\User;
    // use App\Models\User as UserModel;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/);
      if (m) {
        const parts = m[1].split('\\');
        const name = m[2] || parts[parts.length - 1]; // alias or last segment
        results.push({ specifier: m[1], names: [name] });
      }
    }
  }

  if (lang === 'rust') {
    // use crate::handler::{FormHandler, validate};
    // use std::collections::HashMap;
    for (const line of lines) {
      const trimmed = line.trim();
      // Grouped: use path::{A, B, C};
      const grouped = trimmed.match(/^use\s+([\w:]+)::\{([^}]+)\}\s*;/);
      if (grouped) {
        const names = grouped[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        if (names.length > 0) results.push({ specifier: grouped[1], names });
        continue;
      }
      // Single: use path::Name;
      const single = trimmed.match(/^use\s+([\w:]+)(?:\s+as\s+(\w+))?\s*;/);
      if (single) {
        const segments = single[1].split('::');
        const name = single[2] || segments[segments.length - 1];
        results.push({ specifier: single[1], names: [name] });
      }
    }
  }

  if (lang === 'java') {
    // import com.example.models.Response;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(/^import\s+([\w.]+)\s*;/);
      if (m) {
        const parts = m[1].split('.');
        const name = parts[parts.length - 1];
        if (name !== '*') results.push({ specifier: m[1], names: [name] });
      }
    }
  }

  return results;
}
