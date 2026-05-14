/**
 * AST-aware code chunking with regex-based fallback.
 *
 * Splits source files in a repository into semantic CodeChunk objects at
 * function / class / method boundaries.  Uses a simple recursive directory
 * walker (no external glob dependency) and language-specific regex patterns.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';
import { SOURCE_EXTENSIONS, SKIP_DIRS, walkDir, langFromExt, extractImports, isIndexableFile } from './file-walker.js';
import { parseFile, type TreeSitterEntity } from './tree-sitter-parser.js';

const DEFAULT_MAX_INDEX_FILES = 10_000;

function maxIndexFiles(): number {
  const raw = Number.parseInt(process.env.CODE_SEARCH_MAX_FILES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_INDEX_FILES;
}

// ---------------------------------------------------------------------------
// Language → boundary patterns
// ---------------------------------------------------------------------------

interface BoundaryPattern {
  regex: RegExp;
  entityType: CodeChunk['entityType'];
  /** Extract the entity name from the matched line */
  nameExtractor: (line: string) => string | undefined;
}

function tsPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^export\s+function\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^export\s+function\s+(\w+)/)?.[1],
    },
    {
      regex: /^export\s+class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^export\s+class\s+(\w+)/)?.[1],
    },
    {
      regex: /^export\s+const\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^export\s+const\s+(\w+)/)?.[1],
    },
    {
      regex: /^function\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^function\s+(\w+)/)?.[1],
    },
    {
      regex: /^class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^class\s+(\w+)/)?.[1],
    },
    {
      regex: /^interface\s+/,
      entityType: 'interface',
      nameExtractor: (l) => l.match(/^interface\s+(\w+)/)?.[1],
    },
    {
      regex: /^type\s+/,
      entityType: 'type',
      nameExtractor: (l) => l.match(/^type\s+(\w+)/)?.[1],
    },
  ];
}

function pyPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^def\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^def\s+(\w+)/)?.[1],
    },
    {
      regex: /^class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^class\s+(\w+)/)?.[1],
    },
    {
      regex: /^async\s+def\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^async\s+def\s+(\w+)/)?.[1],
    },
  ];
}

function goPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^func\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)/)?.[1],
    },
    {
      regex: /^type\s+\w+\s+struct/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^type\s+(\w+)\s+struct/)?.[1],
    },
    {
      regex: /^type\s+\w+\s+interface/,
      entityType: 'interface',
      nameExtractor: (l) => l.match(/^type\s+(\w+)\s+interface/)?.[1],
    },
  ];
}

function rsPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^(pub\s+)?fn\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/fn\s+(\w+)/)?.[1],
    },
    {
      regex: /^(pub\s+)?struct\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/struct\s+(\w+)/)?.[1],
    },
    {
      regex: /^impl\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^impl\s+(?:<[^>]+>\s+)?(\w+)/)?.[1],
    },
    {
      regex: /^(pub\s+)?trait\s+/,
      entityType: 'interface',
      nameExtractor: (l) => l.match(/trait\s+(\w+)/)?.[1],
    },
    {
      regex: /^(pub\s+)?enum\s+/,
      entityType: 'type',
      nameExtractor: (l) => l.match(/enum\s+(\w+)/)?.[1],
    },
  ];
}

function javaPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^public\s+class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/class\s+(\w+)/)?.[1],
    },
    {
      regex: /^public\s+void\s+/,
      entityType: 'method',
      nameExtractor: (l) => l.match(/void\s+(\w+)/)?.[1],
    },
    {
      regex: /^private\s+void\s+/,
      entityType: 'method',
      nameExtractor: (l) => l.match(/void\s+(\w+)/)?.[1],
    },
    {
      regex: /^public\s+static\s+/,
      entityType: 'method',
      nameExtractor: (l) => l.match(/static\s+\w+\s+(\w+)/)?.[1],
    },
  ];
}

function patternsForLanguage(lang: string): BoundaryPattern[] {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return tsPatterns();
    case 'python':
      return pyPatterns();
    case 'go':
      return goPatterns();
    case 'rust':
      return rsPatterns();
    case 'java':
      return javaPatterns();
    default:
      return tsPatterns();
  }
}

function chunkId(filePath: string, startLine: number, endLine: number): string {
  return createHash('sha256')
    .update(`${filePath}${startLine}${endLine}`)
    .digest('hex')
    .slice(0, 16);
}

/** Detect exported symbols in a chunk. */
function extractExports(content: string, lang: string): string[] {
  const exports: string[] = [];
  if (lang === 'typescript' || lang === 'javascript') {
    const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      exports.push(m[1]);
    }
  }
  return exports;
}

/** Build a structural context prefix for a chunk. Capped to stay within budget. */
function buildContextPrefix(
  relPath: string,
  lang: string,
  imports: string[],
): string {
  const commentPrefix = lang === 'python' ? '#' : '//';
  const moduleName = dirname(relPath).split('/').filter(Boolean).pop() ?? basename(relPath);
  const lines = [
    `${commentPrefix} File: ${relPath}`,
    `${commentPrefix} Module: ${moduleName}`,
  ];
  if (imports.length > 0) {
    // Cap imports to keep prefix under ~200 chars — the rest of the budget is for content
    const maxImportChars = 150;
    const importStr = imports.join(', ');
    const capped = importStr.length > maxImportChars
      ? importStr.slice(0, maxImportChars) + '...'
      : importStr;
    lines.push(`${commentPrefix} Imports: ${capped}`);
  }
  return lines.join('\n');
}

function compactSnippet(content: string, maxLines: number, maxChars: number): string {
  const body = content
    .split('\n')
    .slice(0, maxLines)
    .join('\n')
    .trim();
  return body.length > maxChars ? `${body.slice(0, maxChars)}...` : body;
}

function firstCodeLine(content: string): string | undefined {
  const line = content.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function buildEmbedText(args: {
  relPath: string;
  lang: string;
  entityType: CodeChunk['entityType'];
  entityName?: string;
  content: string;
  imports: string[];
  exports: string[];
}): string {
  const parts = [
    `file:${args.relPath}`,
    `language:${args.lang}`,
    `kind:${args.entityType}`,
  ];
  if (args.entityName) parts.push(`name:${args.entityName}`);
  const signature = firstCodeLine(args.content);
  if (signature) parts.push(`signature:${signature}`);
  if (args.imports.length > 0) parts.push(`imports:${args.imports.slice(0, 12).join(', ')}`);
  if (args.exports.length > 0) parts.push(`exports:${args.exports.slice(0, 12).join(', ')}`);
  const body = compactSnippet(args.content, 15, 500);
  if (body) parts.push(`body:${body}`);
  return parts.join('\n');
}

function uncoveredLineSpans(totalLines: number, covered: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
  const sorted = covered
    .map((span) => ({ startLine: Math.max(1, span.startLine), endLine: Math.min(totalLines, span.endLine) }))
    .filter((span) => span.startLine <= span.endLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const spans: Array<{ startLine: number; endLine: number }> = [];
  let cursor = 1;
  for (const span of sorted) {
    if (cursor < span.startLine) spans.push({ startLine: cursor, endLine: span.startLine - 1 });
    cursor = Math.max(cursor, span.endLine + 1);
  }
  if (cursor <= totalLines) spans.push({ startLine: cursor, endLine: totalLines });
  return spans;
}

function meaningfulLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Chunk a single file
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for the full contextualized content (prefix + content).
 * This is what actually gets sent to the embedding model.
 */
function contextualizedTokens(contextPrefix: string, content: string): number {
  return Math.ceil((contextPrefix.length + 1 + content.length) / 4);
}

/**
 * Split oversized content into sub-chunks that fit within maxTokens.
 * Splits at line boundaries, preserving as much context as possible.
 */
function splitOversizedContent(
  contentLines: string[],
  maxContentChars: number,
): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of contentLines) {
    const lineLen = line.length + 1; // +1 for newline

    // If a single line exceeds the budget, hard-truncate it
    if (lineLen > maxContentChars) {
      if (current.length > 0) {
        parts.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      parts.push(line.slice(0, maxContentChars));
      continue;
    }

    if (currentLen + lineLen > maxContentChars && current.length > 0) {
      parts.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) {
    parts.push(current.join('\n'));
  }
  return parts;
}

function mapTreeSitterEntityType(type: TreeSitterEntity['type']): CodeChunk['entityType'] {
  switch (type) {
    case 'function':
    case 'class':
    case 'method':
    case 'interface':
    case 'type':
    case 'module':
      return type;
    case 'struct':
      return 'class';
    case 'enum':
    case 'trait':
      return 'type';
    default:
      return 'block';
  }
}

async function chunkFile(
  filePath: string,
  repoPath: string,
  repoName: string,
  project: string,
  maxTokens: number,
  diagnostics?: ChunkDiagnostics,
): Promise<CodeChunk[]> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const relPath = relative(repoPath, filePath);
  const ext = extname(filePath);
  const lang = langFromExt(ext);
  const lines = raw.split('\n');
  const patterns = patternsForLanguage(lang);
  const fileImports = extractImports(lines, lang);
  const contextPrefix = buildContextPrefix(relPath, lang, fileImports);

  // Reserve tokens for the context prefix so content fits within model context
  const prefixTokens = Math.ceil(contextPrefix.length / 4) + 1;
  const maxContentTokens = maxTokens - prefixTokens;
  const maxContentChars = maxContentTokens * 4;

  // Find boundary line indices
  const boundaries: Array<{
    line: number;
    entityType: CodeChunk['entityType'];
    entityName: string | undefined;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    for (const pat of patterns) {
      if (pat.regex.test(trimmed)) {
        boundaries.push({
          line: i,
          entityType: pat.entityType,
          entityName: pat.nameExtractor(trimmed),
        });
        break;
      }
    }
  }

  const chunks: CodeChunk[] = [];

  const pushChunk = (
    content: string,
    startLine: number,
    endLine: number,
    entityType: CodeChunk['entityType'],
    entityName: string | undefined,
    parentEntity?: string,
  ) => {
    const ctxContent = `${contextPrefix}\n${content}`;
    const exports = extractExports(content, lang);
    const embedText = buildEmbedText({
      relPath,
      lang,
      entityType,
      entityName,
      content,
      imports: fileImports,
      exports,
    });
    const tokens = Math.ceil(ctxContent.length / 4);
    const id = chunkId(relPath, startLine, endLine);
    chunks.push({
      id,
      filePath: relPath,
      repoName,
      project,
      startLine,
      endLine,
      content,
      contextPrefix,
      contextualizedContent: ctxContent,
      embedText,
      language: lang,
      entityType,
      entityName,
      parentEntity,
      tokens,
      imports: fileImports,
      exports,
    });
  };

  const pushContentWithSplit = (
    contentLines: string[],
    startLine: number,
    entityType: CodeChunk['entityType'],
    entityName: string | undefined,
    parentEntity?: string,
  ) => {
    const content = contentLines.join('\n');
    if (contextualizedTokens(contextPrefix, content) <= maxTokens) {
      pushChunk(content, startLine, startLine + contentLines.length - 1, entityType, entityName, parentEntity);
    } else {
      // Split oversized content into parts that fit
      const parts = splitOversizedContent(contentLines, maxContentChars);
      let lineOffset = startLine;
      for (let p = 0; p < parts.length; p++) {
        const partLines = parts[p].split('\n').length;
        const partName = entityName ? `${entityName}$${p + 1}` : undefined;
        pushChunk(parts[p], lineOffset, lineOffset + partLines - 1, entityType, partName, parentEntity);
        lineOffset += partLines;
      }
    }
  };

  try {
    const parsed = await parseFile(filePath, raw, lang);
    if (parsed?.entities.length) {
      const covered: Array<{ startLine: number; endLine: number }> = [];
      if (diagnostics) diagnostics.treeSitterFiles += 1;
      for (const entity of parsed.entities) {
        const bodyLines = entity.body.split('\n');
        covered.push({ startLine: entity.startLine + 1, endLine: entity.endLine + 1 });
        pushContentWithSplit(
          bodyLines,
          entity.startLine + 1,
          mapTreeSitterEntityType(entity.type),
          entity.name,
          entity.parent,
        );
      }
      for (const span of uncoveredLineSpans(lines.length, covered)) {
        const spanLines = lines.slice(span.startLine - 1, span.endLine);
        if (meaningfulLines(spanLines).length === 0) continue;
        const kind = span.startLine === 1 ? 'import' : 'module';
        if (diagnostics) diagnostics.moduleSpansAdded += 1;
        pushContentWithSplit(spanLines, span.startLine, kind, kind === 'module' ? basename(filePath, ext) : undefined);
      }
      return chunks;
    }
  } catch {
    // Fall through to regex chunking when WASM grammars are unavailable or parsing fails.
  }

  if (diagnostics) diagnostics.regexFallbackFiles += 1;

  // If no boundaries found, treat entire file as one (possibly split) chunk
  if (boundaries.length === 0) {
    pushContentWithSplit(lines, 1, 'module', basename(filePath, ext));
    return chunks;
  }

  // Leading content before the first boundary
  if (boundaries[0].line > 0) {
    const leadLines = lines.slice(0, boundaries[0].line);
    const content = leadLines.join('\n').trimEnd();
    if (content.length > 0) {
      pushContentWithSplit(leadLines, 1, 'import', undefined);
    }
  }

  // Build chunks between boundaries
  for (let i = 0; i < boundaries.length; i++) {
    const startLine = boundaries[i].line;
    const endLine = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length - 1;
    const chunkLines = lines.slice(startLine, endLine + 1);
    pushContentWithSplit(chunkLines, startLine + 1, boundaries[i].entityType, boundaries[i].entityName);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Per-file content-hash caching types
// ---------------------------------------------------------------------------

export interface FileIndexEntry {
  contentHash: string;
  mtimeMs?: number;
  size?: number;
  chunkCount: number;
  chunks?: ChunkIndexEntry[];
}

export interface ChunkIndexEntry {
  id: string;
  stableKey: string;
  contentHash: string;
  embedHash: string;
  startLine: number;
  endLine: number;
  entityType: CodeChunk['entityType'];
  entityName?: string;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableChunkKey(chunk: Pick<CodeChunk, 'entityType' | 'entityName' | 'parentEntity' | 'startLine'>): string {
  const name = chunk.entityName ?? `line:${chunk.startLine}`;
  const parent = chunk.parentEntity ?? '';
  return `${chunk.entityType}:${parent}:${name}`;
}

function enrichChunkMetadata(chunks: CodeChunk[]): CodeChunk[] {
  return chunks.map((chunk) => {
    const stableKey = stableChunkKey(chunk);
    const contentHash = hashText(chunk.content);
    const embedHash = hashText(chunk.embedText ?? chunk.contextualizedContent);
    return { ...chunk, stableKey, contentHash, embedHash };
  });
}

function chunkIndexFromChunks(chunks: CodeChunk[]): ChunkIndexEntry[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    stableKey: chunk.stableKey ?? stableChunkKey(chunk),
    contentHash: chunk.contentHash ?? hashText(chunk.content),
    embedHash: chunk.embedHash ?? hashText(chunk.embedText ?? chunk.contextualizedContent),
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    entityType: chunk.entityType,
    entityName: chunk.entityName,
  }));
}

function fileIndexEntry(filePath: string, contentHash: string, chunks: CodeChunk[]): FileIndexEntry {
  let mtimeMs: number | undefined;
  let size: number | undefined;
  try {
    const stat = statSync(filePath);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    // File may have disappeared between read and metadata capture.
  }
  return { contentHash, mtimeMs, size, chunkCount: chunks.length, chunks: chunkIndexFromChunks(chunks) };
}

export interface ChunkResult {
  /** Chunks from changed/new files only (need embedding) */
  chunks: CodeChunk[];
  /** Relative paths of files that were new or modified */
  changedFiles: string[];
  /** Relative paths of files present in cache but no longer on disk */
  deletedFiles: string[];
  /** Updated per-file metadata for saving */
  fileIndex: Record<string, FileIndexEntry>;
  /** Best-effort diagnostics for logging/debugging */
  diagnostics?: ChunkDiagnostics;
}

export interface ChunkDiagnostics {
  filesConsidered: number;
  filesChunked: number;
  filesSkippedUnchanged: number;
  treeSitterFiles: number;
  regexFallbackFiles: number;
  moduleSpansAdded: number;
}

function createChunkDiagnostics(filesConsidered: number): ChunkDiagnostics {
  return {
    filesConsidered,
    filesChunked: 0,
    filesSkippedUnchanged: 0,
    treeSitterFiles: 0,
    regexFallbackFiles: 0,
    moduleSpansAdded: 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk all source files in a repository into semantic CodeChunk objects.
 *
 * Walks the directory tree, skipping common non-source directories, and
 * splits each source file at function/class/method boundaries using
 * language-specific regex patterns.
 *
 * When `cachedFiles` is provided, unchanged files (matching content hash)
 * are skipped — only new/modified files are chunked and returned.
 */
export async function chunkRepo(
  repoPath: string,
  repoName: string,
  project: string,
  config: { maxTokens: number },
  cachedFiles?: Record<string, FileIndexEntry>,
): Promise<ChunkResult> {
  const files: string[] = [];
  walkDir(repoPath, files);
  const diagnostics = createChunkDiagnostics(files.length);
  const fileLimit = maxIndexFiles();
  if (files.length > fileLimit) {
    throw new Error(`too many indexable files in ${repoName}: ${files.length} exceeds CODE_SEARCH_MAX_FILES=${fileLimit}. Open a narrower directory or raise the limit.`);
  }

  const allChunks: CodeChunk[] = [];
  const changedFiles: string[] = [];
  const fileIndex: Record<string, FileIndexEntry> = {};
  const currentFilePaths = new Set<string>();

  for (const file of files) {
    const relPath = relative(repoPath, file);
    currentFilePaths.add(relPath);

    // Compute content hash for cache comparison
    let contents: string;
    try {
      contents = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const contentHash = hashText(contents);

    // Check cache — skip chunking if file is unchanged
    if (cachedFiles?.[relPath]?.contentHash === contentHash) {
      fileIndex[relPath] = cachedFiles[relPath];
      diagnostics.filesSkippedUnchanged += 1;
      continue;
    }

    // File is new or changed — chunk it
    changedFiles.push(relPath);
    diagnostics.filesChunked += 1;
    const chunks = enrichChunkMetadata(await chunkFile(file, repoPath, repoName, project, config.maxTokens, diagnostics));
    allChunks.push(...chunks);
    fileIndex[relPath] = fileIndexEntry(file, contentHash, chunks);
  }

  // Detect deleted files (in cache but no longer on disk)
  const deletedFiles: string[] = [];
  if (cachedFiles) {
    for (const path of Object.keys(cachedFiles)) {
      if (!currentFilePaths.has(path)) {
        deletedFiles.push(path);
      }
    }
  }

  return { chunks: allChunks, changedFiles, deletedFiles, fileIndex, diagnostics };
}

// ---------------------------------------------------------------------------
// Incremental chunking — only chunk files identified by git diff
// ---------------------------------------------------------------------------

/**
 * Chunk only the files that git diff identified as changed.
 * Much faster than chunkRepo() which iterates ALL files.
 */
export async function chunkChangedFiles(
  repoPath: string,
  repoName: string,
  project: string,
  config: { maxTokens: number },
  diff: { added: string[]; modified: string[]; deleted: string[] },
): Promise<ChunkResult> {
  const allChunks: CodeChunk[] = [];
  const changedFiles: string[] = [];
  const fileIndex: Record<string, FileIndexEntry> = {};
  const diagnostics = createChunkDiagnostics(diff.added.length + diff.modified.length);

  // Only chunk added + modified files
  for (const relPath of [...diff.added, ...diff.modified]) {
    const fullPath = join(repoPath, relPath);
    if (!existsSync(fullPath)) continue;
    const ext = extname(fullPath);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (!isIndexableFile(repoPath, fullPath)) continue;

    let contents: string;
    try {
      contents = readFileSync(fullPath, 'utf-8');
    } catch { continue; }

    changedFiles.push(relPath);
    diagnostics.filesChunked += 1;
    const contentHash = hashText(contents);
    const chunks = enrichChunkMetadata(await chunkFile(fullPath, repoPath, repoName, project, config.maxTokens, diagnostics));
    allChunks.push(...chunks);
    fileIndex[relPath] = fileIndexEntry(fullPath, contentHash, chunks);
  }

  return {
    chunks: allChunks,
    changedFiles,
    deletedFiles: [...diff.deleted],
    fileIndex,
    diagnostics,
  };
}
