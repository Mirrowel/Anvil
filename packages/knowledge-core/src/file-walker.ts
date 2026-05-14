/**
 * Shared file-walking utilities extracted from chunker.ts.
 *
 * Provides: SKIP_DIRS, walkDir, langFromExt, extractImports,
 *           NamedImportSpec, extractNamedImports
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', '__pycache__', 'target', 'venv', '.venv',
  '.tox', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage', '.opencode',
  '.alfonso', '.gsd', '.anvil-kb',
]);

const BLACKLISTED_EXTENSIONS = new Set([
  '.md', '.mdx', '.rst', '.txt', '.adoc', '.asciidoc',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif', '.heic',
  '.svg', '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.rar', '.7z',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.class', '.jar', '.war', '.pyc', '.pyo', '.o', '.obj', '.a', '.lib',
  '.map', '.lock',
]);

const BLACKLISTED_FILENAMES = new Set([
  '.gitignore',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'cargo.lock',
  'poetry.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock',
  'copying', 'copying.lesser',
]);

const BLACKLISTED_NAME_PREFIXES = [
  'readme', 'changelog', 'license', 'notice', 'authors', 'contributors',
  'contributing', 'code_of_conduct', 'security',
];

export const INDEX_IGNORE_FILE = 'index.ignore';
export const EXAMPLE_INDEX_IGNORE_FILE = 'example.index.ignore';

const DEFAULT_MAX_FILE_SIZE_BYTES = 2_000_000;

const _thisDir = dirname(fileURLToPath(import.meta.url));
const BUNDLED_EXAMPLE_PATH = join(_thisDir, '..', EXAMPLE_INDEX_IGNORE_FILE);
const PLACEHOLDER = '%%DEFAULT_EXCLUDES%%';

function generateDefaultExcludes(): string {
  const lines: string[] = [];

  lines.push('# --- Skipped directories ---');
  for (const dir of [...SKIP_DIRS].sort()) lines.push(`${dir}/`);

  lines.push('');
  lines.push('# --- Blacklisted extensions ---');
  for (const ext of [...BLACKLISTED_EXTENSIONS].sort()) lines.push(`*${ext}`);

  lines.push('');
  lines.push('# --- Blacklisted filenames ---');
  for (const name of [...BLACKLISTED_FILENAMES].sort()) lines.push(name);

  lines.push('');
  lines.push('# --- Blacklisted name prefixes ---');
  for (const prefix of [...BLACKLISTED_NAME_PREFIXES].sort()) lines.push(`${prefix}*`);

  lines.push('');
  lines.push('# --- Special rules ---');
  lines.push('.env');
  lines.push('.env.*');
  lines.push('!.env.example');

  return lines.join('\n');
}

export function ensureIndexIgnore(targetDir: string): boolean {
  const indexPath = join(targetDir, INDEX_IGNORE_FILE);
  if (existsSync(indexPath)) return false;
  const examplePath = join(targetDir, EXAMPLE_INDEX_IGNORE_FILE);
  const source = existsSync(examplePath) ? examplePath : BUNDLED_EXAMPLE_PATH;
  if (!existsSync(source)) return false;
  try {
    let content = readFileSync(source, 'utf-8');
    if (content.includes(PLACEHOLDER)) {
      content = content.replace(PLACEHOLDER, generateDefaultExcludes());
    }
    writeFileSync(indexPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function maxFileSizeBytes(): number {
  const raw = Number.parseInt(process.env.CODE_SEARCH_MAX_FILE_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_SIZE_BYTES;
}

type IgnoreMatcher = ReturnType<typeof ignore>;

interface IndexIgnoreRule {
  pattern: string;
  include: boolean;
  matcher: IgnoreMatcher;
}

interface IndexIgnoreRuleset {
  rules: IndexIgnoreRule[];
}

export interface IndexIgnoreDiagnostics {
  root: string;
  indexIgnorePath: string;
  indexIgnoreExists: boolean;
  gitIgnored: string[];
  indexIgnored: string[];
  indexWhitelisted: string[];
  indexExcludedByOrder: string[];
}

export type IndexSkipReason = 'directory' | 'blacklist' | 'size' | 'binary' | 'gitignore' | 'index.ignore';

export interface IndexFileDiagnostics extends IndexIgnoreDiagnostics {
  skippedByDirectory: string[];
  skippedByBlacklist: string[];
  skippedBySize: string[];
  skippedAsBinary: string[];
  skippedByGitignore: string[];
  skippedByIndexIgnore: string[];
  indexable: string[];
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
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.toml':
      return 'toml';
    case '.sql':
      return 'sql';
    case '.proto':
      return 'proto';
    case '.graphql':
    case '.gql':
      return 'graphql';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell';
    case '.ps1':
      return 'powershell';
    case '.tf':
    case '.hcl':
      return 'hcl';
    case '.ini':
    case '.conf':
    case '.properties':
      return 'config';
    case '.xml':
      return 'xml';
    default:
      return 'text';
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
  const indexExcludedByOrder: string[] = [];

  for (const relPath of relFiles) {
    if (!matchesAnyIndexIgnoreRule(indexIgnore, relPath)) continue;
    const included = evaluateIndexIgnore(indexIgnore, relPath);
    if (included) {
      indexWhitelisted.push(relPath);
    } else {
      if (gitIgnored.has(relPath)) {
        indexExcludedByOrder.push(relPath);
      } else {
        indexIgnored.push(relPath);
      }
    }
  }

  return {
    root,
    indexIgnorePath,
    indexIgnoreExists: existsSync(indexIgnorePath),
    gitIgnored: [...gitIgnored].sort(),
    indexIgnored: indexIgnored.sort(),
    indexWhitelisted: indexWhitelisted.sort(),
    indexExcludedByOrder: indexExcludedByOrder.sort(),
  };
}

export function getIndexFileDiagnostics(root: string): IndexFileDiagnostics {
  const rawFiles: string[] = [];
  const skippedByDirectory: string[] = [];
  walkAllFiles(root, rawFiles, skippedByDirectory);
  const relByAbs = new Map(rawFiles.map((file) => [file, toRelPath(root, file)]));
  const relFiles = [...relByAbs.values()];
  const gitIgnored = getGitIgnoredPaths(root, relFiles);
  const indexIgnore = loadIndexIgnore(join(root, INDEX_IGNORE_FILE));
  const indexIgnorePath = join(root, INDEX_IGNORE_FILE);
  const skippedByBlacklist: string[] = [];
  const skippedBySize: string[] = [];
  const skippedAsBinary: string[] = [];
  const skippedByGitignore: string[] = [];
  const skippedByIndexIgnore: string[] = [];
  const indexWhitelisted: string[] = [];
  const indexExcludedByOrder: string[] = [];
  const indexable: string[] = [];

  for (const file of rawFiles) {
    const relPath = relByAbs.get(file);
    if (!relPath) continue;

    const hasIndexIgnoreRule = matchesAnyIndexIgnoreRule(indexIgnore, relPath);
    const indexIgnoreInclude = hasIndexIgnoreRule ? evaluateIndexIgnore(indexIgnore, relPath) : false;

    if (hasIndexIgnoreRule && indexIgnoreInclude) {
      indexWhitelisted.push(relPath);
      indexable.push(relPath);
      continue;
    }

    if (hasIndexIgnoreRule && !indexIgnoreInclude) {
      if (gitIgnored.has(relPath)) {
        indexExcludedByOrder.push(relPath);
      } else {
        skippedByIndexIgnore.push(relPath);
      }
      continue;
    }

    if (isBlacklistedFile(file)) {
      skippedByBlacklist.push(relPath);
      continue;
    }
    if (isOversized(file)) {
      skippedBySize.push(relPath);
      continue;
    }
    if (isBinaryFile(file)) {
      skippedAsBinary.push(relPath);
      continue;
    }
    if (gitIgnored.has(relPath)) {
      skippedByGitignore.push(relPath);
      continue;
    }

    indexable.push(relPath);
  }

  return {
    root,
    indexIgnorePath,
    indexIgnoreExists: existsSync(indexIgnorePath),
    gitIgnored: [...gitIgnored].sort(),
    indexIgnored: skippedByIndexIgnore.sort(),
    indexWhitelisted: indexWhitelisted.sort(),
    indexExcludedByOrder: indexExcludedByOrder.sort(),
    skippedByDirectory: skippedByDirectory.sort(),
    skippedByBlacklist: skippedByBlacklist.sort(),
    skippedBySize: skippedBySize.sort(),
    skippedAsBinary: skippedAsBinary.sort(),
    skippedByGitignore: skippedByGitignore.sort(),
    skippedByIndexIgnore: skippedByIndexIgnore.sort(),
    indexable: indexable.sort(),
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

    const hasIndexIgnoreRule = matchesAnyIndexIgnoreRule(indexIgnore, relPath);
    if (hasIndexIgnoreRule) {
      return evaluateIndexIgnore(indexIgnore, relPath);
    }

    if (isBlacklistedFile(file)) return false;
    if (isOversized(file)) return false;
    if (isBinaryFile(file)) return false;
    if (gitIgnored.has(relPath)) return false;
    return true;
  });
}

export function isIndexableFile(root: string, file: string): boolean {
  return filterIndexableFiles(root, [file]).length === 1;
}

function walkDirRaw(dir: string, collected: string[]): void {
  walkAllFiles(dir, collected, []);
}

function walkAllFiles(dir: string, collected: string[], skippedDirs: string[], root: string = dir): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // permission error or similar — skip
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) {
        skippedDirs.push(toRelPath(root, full));
        continue;
      }
      walkAllFiles(full, collected, skippedDirs, root);
    } else if (stat.isFile()) {
      collected.push(full);
    }
  }
}

function isBlacklistedFile(file: string): boolean {
  const ext = extname(file).toLowerCase();
  const name = basename(file).toLowerCase();
  if (name === '.env') return true;
  if (BLACKLISTED_EXTENSIONS.has(ext)) return true;
  if (BLACKLISTED_FILENAMES.has(name)) return true;
  if (name.endsWith('.min.js')) return true;
  return BLACKLISTED_NAME_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
}

function isOversized(file: string): boolean {
  try {
    return statSync(file).size > maxFileSizeBytes();
  } catch {
    return true;
  }
}

function isBinaryFile(file: string): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file).subarray(0, 8192);
  } catch {
    return true;
  }
  if (bytes.length === 0) return false;
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / bytes.length > 0.3;
}

function getGitIgnoredPaths(root: string, relFiles: string[]): Set<string> {
  if (relFiles.length === 0) return new Set();
  try {
    const output = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
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

function loadIndexIgnore(ignorePath: string): IndexIgnoreRuleset {
  const rules: IndexIgnoreRule[] = [];
  if (!existsSync(ignorePath)) return { rules };

  let contents: string;
  try {
    contents = readFileSync(ignorePath, 'utf-8');
  } catch {
    return { rules };
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!!')) continue;

    const include = line.startsWith('!');
    const pattern = include ? line.slice(1) : line;
    if (!pattern) continue;

    rules.push({ pattern, include, matcher: ignore().add(pattern) });
  }

  return { rules };
}

function evaluateIndexIgnore(ruleset: IndexIgnoreRuleset, relPath: string): boolean {
  let included: boolean | null = null;
  for (const rule of ruleset.rules) {
    if (rule.matcher.ignores(relPath)) {
      included = rule.include;
    }
  }
  return included ?? false;
}

function matchesAnyIndexIgnoreRule(ruleset: IndexIgnoreRuleset, relPath: string): boolean {
  for (const rule of ruleset.rules) {
    if (rule.matcher.ignores(relPath)) return true;
  }
  return false;
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
