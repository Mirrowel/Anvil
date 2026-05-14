/**
 * Tests for chunker.ts — AST-aware code chunking.
 *
 * We cannot easily call chunkRepo() (it walks a real directory), so we
 * test the chunking logic by writing temp files and invoking chunkRepo
 * on a small temp directory, or by testing the observable behavior through
 * the public API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chunkRepo } from '@esankhan3/anvil-knowledge-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  const dir = join(tmpdir(), `chunker-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chunkRepo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('chunks a simple TypeScript file into expected chunks', async () => {
    const code = [
      'import { readFile } from "node:fs";',
      '',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      'export function farewell(name: string): string {',
      '  return `Goodbye, ${name}!`;',
      '}',
    ].join('\n');

    writeFileSync(join(tempDir, 'utils.ts'), code);

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    assert.ok(result.chunks.length >= 2, `Expected >= 2 chunks, got ${result.chunks.length}`);

    // Should have at least one chunk with entityName 'greet' and one with 'farewell'
    const names = result.chunks.map((c) => c.entityName).filter(Boolean);
    assert.ok(names.includes('greet'), 'Should have a "greet" chunk');
    assert.ok(names.includes('farewell'), 'Should have a "farewell" chunk');
  });

  it('preserves entity boundaries — functions are not split mid-body', async () => {
    // A function small enough to fit in one chunk should not be split
    const code = [
      'export function compute(x: number): number {',
      '  const a = x * 2;',
      '  const b = a + 1;',
      '  return b;',
      '}',
    ].join('\n');

    writeFileSync(join(tempDir, 'compute.ts'), code);

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    // The function should be in exactly one chunk
    const computeChunks = result.chunks.filter((c) => c.entityName === 'compute');
    assert.equal(computeChunks.length, 1, 'Small function should be a single chunk');

    // The chunk should contain the full function body
    assert.ok(computeChunks[0].content.includes('return b;'), 'Chunk should contain full body');
  });

  it('respects max token limits by splitting large content', async () => {
    // Create a file with many functions that would exceed a small token limit
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`export function fn${i}() {`);
      // Add enough lines to make the chunk substantial
      for (let j = 0; j < 10; j++) {
        lines.push(`  const v${j} = ${j} + ${i};`);
      }
      lines.push('  return 0;');
      lines.push('}');
      lines.push('');
    }

    writeFileSync(join(tempDir, 'big.ts'), lines.join('\n'));

    // Use a very small maxTokens to force splitting
    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 64 });

    // With a 64-token limit, each function chunk should be small
    for (const chunk of result.chunks) {
      const tokenEstimate = Math.ceil(chunk.contextualizedContent.length / 4);
      // Allow some tolerance since splitting is at line boundaries
      assert.ok(
        tokenEstimate <= 128,
        `Chunk "${chunk.entityName}" has ~${tokenEstimate} tokens, expected <= ~128 (2x budget for boundary tolerance)`,
      );
    }
  });

  it('empty file produces no chunks', async () => {
    writeFileSync(join(tempDir, 'empty.ts'), '');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    // Empty file should produce zero or at most one empty chunk
    const emptyChunks = result.chunks.filter((c) => c.filePath.includes('empty.ts'));
    // An empty file has no content and no boundaries, so it should produce 0 chunks
    // (the module chunk would have empty content which gets trimmed)
    assert.ok(
      emptyChunks.length === 0 || emptyChunks.every((c) => c.content.trim() === ''),
      'Empty file should produce no meaningful chunks',
    );
  });

  it('sets correct metadata on chunks', async () => {
    const code = 'export function hello() { return "hi"; }';
    writeFileSync(join(tempDir, 'meta.ts'), code);

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    assert.ok(result.chunks.length > 0);
    const chunk = result.chunks.find((c) => c.entityName === 'hello');
    assert.ok(chunk, 'Should find "hello" chunk');
    assert.equal(chunk.repoName, 'test-repo');
    assert.equal(chunk.project, 'test-project');
    assert.equal(chunk.language, 'typescript');
    assert.equal(chunk.entityType, 'function');
    assert.ok(chunk.id.length > 0, 'Chunk should have an id');
    assert.ok(chunk.tokens > 0, 'Chunk should have token estimate');
    assert.ok(chunk.contextPrefix.length > 0, 'Chunk should have context prefix');
    assert.ok(chunk.contextualizedContent.length > chunk.content.length, 'Contextualized content should include prefix');
    assert.ok(chunk.embedText?.includes('file:meta.ts'), 'Chunk should have compact embedding text with file path');
    assert.ok(chunk.embedText?.includes('kind:function'), 'Chunk should have compact embedding text with kind');
  });

  it('preserves module-level setup around tree-sitter entity chunks', async () => {
    const code = [
      'import express from "express";',
      'const app = express();',
      'app.use(express.json());',
      '',
      'export function handler() {',
      '  return app;',
      '}',
      '',
      'app.listen(3000);',
    ].join('\n');
    writeFileSync(join(tempDir, 'server.ts'), code);

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    assert.ok(result.chunks.some((c) => c.entityName === 'handler'), 'Should include tree-sitter function chunk');
    assert.ok(
      result.chunks.some((c) => c.content.includes('app.use(express.json())')),
      'Should preserve uncovered module setup before function',
    );
    assert.ok(
      result.chunks.some((c) => c.content.includes('app.listen(3000)')),
      'Should preserve uncovered module setup after function',
    );
  });

  it('honors CODE_SEARCH_MAX_FILES guardrail', async () => {
    const previous = process.env.CODE_SEARCH_MAX_FILES;
    process.env.CODE_SEARCH_MAX_FILES = '1';
    try {
      writeFileSync(join(tempDir, 'a.ts'), 'export const a = 1;');
      writeFileSync(join(tempDir, 'b.ts'), 'export const b = 2;');

      await assert.rejects(
        () => chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 }),
        /too many indexable files/,
      );
    } finally {
      if (previous === undefined) delete process.env.CODE_SEARCH_MAX_FILES;
      else process.env.CODE_SEARCH_MAX_FILES = previous;
    }
  });

  it('returns changedFiles and fileIndex', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'const a = 1;');
    writeFileSync(join(tempDir, 'b.ts'), 'const b = 2;');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    // Both files should be in changedFiles (no cache provided)
    assert.ok(result.changedFiles.length >= 2);
    assert.ok(Object.keys(result.fileIndex).length >= 2);
  });

  it('skips unchanged files when cache is provided', async () => {
    writeFileSync(join(tempDir, 'cached.ts'), 'const cached = 1;');

    // First pass — get the file index
    const first = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });
    assert.ok(first.changedFiles.length > 0);

    // Second pass with cache — file is unchanged
    const second = await chunkRepo(
      tempDir,
      'test-repo',
      'test-project',
      { maxTokens: 512 },
      first.fileIndex,
    );

    assert.equal(second.changedFiles.length, 0, 'No files should be changed on second pass');
    assert.equal(second.chunks.length, 0, 'No new chunks needed');
  });

  it('detects deleted files compared to cache', async () => {
    writeFileSync(join(tempDir, 'willdelete.ts'), 'const x = 1;');

    const first = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    // Delete the file
    rmSync(join(tempDir, 'willdelete.ts'));

    const second = await chunkRepo(
      tempDir,
      'test-repo',
      'test-project',
      { maxTokens: 512 },
      first.fileIndex,
    );

    assert.ok(
      second.deletedFiles.some((f) => f.includes('willdelete.ts')),
      'Should detect deleted file',
    );
  });

  it('handles non-source files gracefully (skips them)', async () => {
    writeFileSync(join(tempDir, 'readme.md'), '# Hello');
    writeFileSync(join(tempDir, 'notes.txt'), 'Hello user-facing prose');
    writeFileSync(join(tempDir, 'code.ts'), 'export const x = 1;');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    const filePaths = result.chunks.map((c) => c.filePath);
    assert.ok(!filePaths.some((p) => p.endsWith('.md')), 'Markdown should be ignored by default');
    assert.ok(!filePaths.some((p) => p.endsWith('.txt')), 'Text prose should be ignored by default');
    assert.ok(filePaths.some((p) => p.endsWith('.ts')), 'Source files should still be chunked');
  });

  it('indexes safe config and schema text files by default', async () => {
    writeFileSync(join(tempDir, 'package.json'), '{"scripts":{"build":"tsc"}}');
    writeFileSync(join(tempDir, 'deploy.yaml'), 'apiVersion: v1\nkind: Service\n');
    writeFileSync(join(tempDir, 'schema.sql'), 'create table users(id integer);');
    writeFileSync(join(tempDir, 'Dockerfile'), 'FROM node:22\nRUN npm ci\n');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });
    const filePaths = result.chunks.map((c) => c.filePath);

    assert.ok(filePaths.includes('package.json'), 'JSON config should be indexed');
    assert.ok(filePaths.includes('deploy.yaml'), 'YAML config should be indexed');
    assert.ok(filePaths.includes('schema.sql'), 'SQL files should be indexed');
    assert.ok(filePaths.includes('Dockerfile'), 'Dockerfile should be indexed');
  });

  it('ignores binary-looking files even with text-like extension', async () => {
    writeFileSync(join(tempDir, 'binary.json'), Buffer.from([0, 1, 2, 3, 4, 5, 0, 10]));

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    assert.ok(!result.chunks.some((c) => c.filePath === 'binary.json'), 'Binary-looking file should be skipped');
  });

  it('skips common generated directories by default', async () => {
    mkdirSync(join(tempDir, 'dist'));
    mkdirSync(join(tempDir, 'target'));
    mkdirSync(join(tempDir, '.anvil-kb'));
    writeFileSync(join(tempDir, 'dist', 'generated.js'), 'export const generated = true;');
    writeFileSync(join(tempDir, 'target', 'generated.rs'), 'pub fn generated() {}');
    writeFileSync(join(tempDir, '.anvil-kb', 'chunks.json'), '{"internal":true}');
    writeFileSync(join(tempDir, 'src.ts'), 'export const kept = true;');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });
    const filePaths = result.chunks.map((c) => c.filePath);

    assert.ok(filePaths.includes('src.ts'), 'Root source file should be indexed');
    assert.ok(!filePaths.some((p) => p.startsWith('dist/')), 'dist should be skipped');
    assert.ok(!filePaths.some((p) => p.startsWith('target/')), 'target should be skipped');
    assert.ok(!filePaths.some((p) => p.startsWith('.anvil-kb/')), '.anvil-kb should be skipped');
  });

  it('ignores .env but indexes .env.example', async () => {
    writeFileSync(join(tempDir, '.env'), 'SECRET=value');
    writeFileSync(join(tempDir, '.env.example'), 'SECRET=example');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });
    const filePaths = result.chunks.map((c) => c.filePath);

    assert.ok(!filePaths.includes('.env'), '.env should be ignored');
    assert.ok(filePaths.includes('.env.example'), '.env.example should be indexed');
  });

  it('allows index.ignore to force-include markdown', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# API contract\nPOST /forms');
    writeFileSync(join(tempDir, 'index.ignore'), '!README.md\n');

    const result = await chunkRepo(tempDir, 'test-repo', 'test-project', { maxTokens: 512 });

    assert.ok(result.chunks.some((c) => c.filePath === 'README.md'), 'Force-included markdown should be indexed');
  });
});
