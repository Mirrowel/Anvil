import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';

import { chunkRepo, chunkChangedFiles } from '@esankhan3/anvil-knowledge-core';
import type { FileIndexEntry, ChunkDiagnostics } from '@esankhan3/anvil-knowledge-core';
import { walkDir, ensureIndexIgnore } from '@esankhan3/anvil-knowledge-core';
import { buildAstGraph, generateGraphReport, incrementalGraphUpdate } from '@esankhan3/anvil-knowledge-core';
import { getAllChanges, getChangedFilesList, getDeletedFilesList } from '@esankhan3/anvil-knowledge-core';
import type { GitDiff } from '@esankhan3/anvil-knowledge-core';
import { createEmbeddingProvider } from '@esankhan3/anvil-knowledge-core';
import { VectorStore } from '@esankhan3/anvil-knowledge-core';
import { ProjectGraphBuilder } from '@esankhan3/anvil-knowledge-core';
import { detectCrossRepoEdges } from '@esankhan3/anvil-knowledge-core';
import { detectWorkspace } from '@esankhan3/anvil-knowledge-core';
import { HybridRetriever } from './retriever.js';
import { loadKnowledgeConfig, getKnowledgeBasePath, DEFAULT_CONFIG } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, IndexStats, WorkspaceMap } from '@esankhan3/anvil-knowledge-core';
import { profileProject, loadAllProfiles } from '@esankhan3/anvil-knowledge-core';
import { inferServiceMesh } from '@esankhan3/anvil-knowledge-core';
import { computeStructuralHashes, deduplicateByStructure } from '@esankhan3/anvil-knowledge-core';
import { createQueryRouter } from '@esankhan3/anvil-knowledge-core';

// ---------------------------------------------------------------------------
// File-based staleness detection
// ---------------------------------------------------------------------------

interface RepoIndexMeta {
  lastIndexedSha: string;
  lastIndexedAt: string;
  chunkCount: number;
  embeddingProvider: string;
  embeddingFingerprint?: EmbeddingFingerprint;
  files?: Record<string, FileIndexEntry>;
}

interface EmbeddingFingerprint {
  provider: string;
  model?: string;
  baseUrl?: string;
  dimensions: number;
  documentPrefix?: string;
  queryPrefix?: string;
}

function embeddingFingerprintFromProvider(provider: ReturnType<typeof createEmbeddingProvider>): EmbeddingFingerprint {
  return {
    provider: provider.name,
    model: provider.model,
    baseUrl: provider.baseUrl,
    dimensions: provider.dimensions,
    documentPrefix: provider.documentPrefix,
    queryPrefix: provider.queryPrefix,
  };
}

function sameEmbeddingFingerprint(a?: EmbeddingFingerprint, b?: EmbeddingFingerprint): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function metaEmbeddingCompatible(meta: RepoIndexMeta | null, expected: EmbeddingFingerprint): boolean {
  if (!meta) return true;
  if (meta.embeddingProvider === 'pending' || meta.embeddingProvider === 'unknown') return true;
  return sameEmbeddingFingerprint(meta.embeddingFingerprint, expected);
}

function formatFingerprint(fingerprint?: EmbeddingFingerprint): string {
  if (!fingerprint) return 'none';
  return `${fingerprint.provider}/${fingerprint.model ?? 'default'} dim=${fingerprint.dimensions} base=${fingerprint.baseUrl ?? 'default'} docPrefix=${fingerprint.documentPrefix ? 'yes' : 'no'} queryPrefix=${fingerprint.queryPrefix ? 'yes' : 'no'}`;
}

function formatChunkDiagnostics(diagnostics?: ChunkDiagnostics): string {
  if (!diagnostics) return 'diagnostics unavailable';
  return `files considered=${diagnostics.filesConsidered}, chunked=${diagnostics.filesChunked}, unchanged=${diagnostics.filesSkippedUnchanged}, tree-sitter=${diagnostics.treeSitterFiles}, regex=${diagnostics.regexFallbackFiles}, module spans=${diagnostics.moduleSpansAdded}`;
}

function maxIndexChunks(): number {
  const raw = Number.parseInt(process.env.CODE_SEARCH_MAX_CHUNKS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 200_000;
}

function getRepoSha(repoPath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function readRepoIndexMeta(basePath: string, repoName: string): RepoIndexMeta | null {
  const metaPath = join(basePath, repoName, 'index_meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeRepoIndexMeta(basePath: string, repoName: string, meta: RepoIndexMeta): void {
  const dir = join(basePath, repoName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface IndexProgress {
  phase: 'profiling' | 'chunking' | 'dedup' | 'embedding' | 'graphing' | 'storing' | 'service-mesh' | 'done';
  message: string;
  /** 0-100 */
  percent: number;
  /** Estimated seconds remaining, -1 if unknown */
  etaSeconds: number;
  chunksTotal?: number;
  chunksProcessed?: number;
  reposTotal?: number;
  reposProcessed?: number;
  skippedRepos?: string[];
}

// ---------------------------------------------------------------------------
// Knowledge Indexer
// ---------------------------------------------------------------------------

export interface BuildKBResult {
  project: string;
  repos: Array<{ name: string; chunkCount: number; language: string }>;
  totalChunks: number;
  totalTokens: number;
  crossRepoEdges: number;
  durationMs: number;
  /** Chunks saved to disk, ready for embedding */
  chunksPath: string;
}

export interface FreshnessStatus {
  stale: boolean;
  reason: string;
  reposChecked: number;
  added: number;
  modified: number;
  deleted: number;
  fingerprintMismatches: string[];
  files: Array<{ repoName: string; filePath: string }>;
}

export class KnowledgeIndexer {

  // ---------------------------------------------------------------------------
  // BUILD KB — fast, static, no embedding. Profiles + chunks + graphs + edges.
  // ---------------------------------------------------------------------------

  async buildKB(
    project: string,
    repos: Array<{ name: string; path: string; language: string }>,
    config: KnowledgeConfig,
    opts?: {
      onProgress?: (msg: string) => void;
      onDetailedProgress?: (progress: IndexProgress) => void;
      force?: boolean;
    },
  ): Promise<BuildKBResult> {
    const log = opts?.onProgress ?? (() => {});
    const report = opts?.onDetailedProgress ?? (() => {});
    const startTime = Date.now();
    const basePath = getKnowledgeBasePath(project);
    mkdirSync(basePath, { recursive: true });
    const expectedEmbeddingFingerprint = embeddingFingerprintFromProvider(createEmbeddingProvider(config.embedding));
    log(`Expected embedding fingerprint: ${formatFingerprint(expectedEmbeddingFingerprint)}`);

    // 1. Determine which repos need re-indexing (SHA check)
    const reposToIndex: typeof repos = [];
    const skippedRepos: string[] = [];
    const fullRebuildReasons = new Map<string, string>();

    for (const repo of repos) {
      if (opts?.force) {
        log(`Planning ${repo.name}: force=true -> full rebuild`);
        reposToIndex.push(repo);
        continue;
      }
      const meta = readRepoIndexMeta(basePath, repo.name);
      if (!metaEmbeddingCompatible(meta, expectedEmbeddingFingerprint)) {
        fullRebuildReasons.set(repo.name, 'embedding fingerprint changed');
        log(`Planning ${repo.name}: embedding fingerprint changed -> full rebuild (stored: ${formatFingerprint(meta?.embeddingFingerprint)}, expected: ${formatFingerprint(expectedEmbeddingFingerprint)})`);
        reposToIndex.push(repo);
        continue;
      }
      const diff = detectFileChanges(repo.path, meta?.files);
      if (meta && !diff.fallbackToFull && (diff.added.length + diff.modified.length + diff.deleted.length) === 0) {
        skippedRepos.push(repo.name);
        log(`Skipping ${repo.name} — unchanged`);
      } else {
        if (!meta) {
          log(`Planning ${repo.name}: no index metadata -> full build`);
        } else if (diff.fallbackToFull) {
          log(`Planning ${repo.name}: file metadata unavailable -> full scan`);
        } else {
          log(`Planning ${repo.name}: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted`);
        }
        reposToIndex.push(repo);
      }
    }

    if (reposToIndex.length === 0) {
      log('All repos up to date — nothing to build.');
      report({ phase: 'done', message: 'All repos up to date', percent: 100, etaSeconds: 0, skippedRepos });
      return { project, repos: [], totalChunks: 0, totalTokens: 0, crossRepoEdges: 0, durationMs: 0, chunksPath: join(basePath, 'chunks.json') };
    }

    // 2. LLM Repo Profiling (WS-1) — skipped if LLM_MODE=none
    const { isLlmAvailable } = await import('./claude-runner.js');
    if (isLlmAvailable()) {
      report({ phase: 'profiling', message: `Profiling ${repos.length} repos with LLM...`, percent: 3, etaSeconds: -1, reposTotal: repos.length, reposProcessed: 0 });
      log(`Profiling ${repos.length} repos with LLM...`);
      try {
        const profiles = await profileProject(project, repos, {
          force: opts?.force,
          onProgress: (m) => {
            log(m);
            report({ phase: 'profiling', message: m, percent: 5, etaSeconds: -1 });
          },
        });
        log(`Profiled ${profiles.length} repos`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Warning: Repo profiling skipped: ${errMsg}`);
        report({ phase: 'profiling', message: `Profiling skipped: ${errMsg.slice(0, 100)}`, percent: 8, etaSeconds: -1 });
      }
    } else {
      log('LLM profiling disabled (CODE_SEARCH_LLM_MODE=none) — skipping');
      report({ phase: 'profiling', message: 'Skipped (LLM disabled)', percent: 8, etaSeconds: -1 });
    }

    // 3. Chunk repos — use git diff for incremental detection
    report({ phase: 'chunking', message: `Chunking ${reposToIndex.length} repos...`, percent: 10, etaSeconds: -1, reposTotal: repos.length, reposProcessed: skippedRepos.length, skippedRepos });
    log(`Chunking ${reposToIndex.length} repos (${skippedRepos.length} skipped — unchanged)...`);
    const allChunks: CodeChunk[] = [];
    const repoStats: Array<{ name: string; chunkCount: number; language: string }> = [];
    const repoChunkResults = new Map<string, { changedFiles: string[]; deletedFiles: string[]; fileIndex: Record<string, FileIndexEntry>; diagnostics?: ChunkDiagnostics }>();
    const repoDiffs = new Map<string, GitDiff>();

    for (const repo of reposToIndex) {
      const meta = opts?.force ? null : readRepoIndexMeta(basePath, repo.name);
      const forceFullReason = fullRebuildReasons.get(repo.name);

      // Use file-level freshness so unstaged/untracked changes are indexed too.
      const diff = opts?.force || forceFullReason ? null : detectFileChanges(repo.path, meta?.files);
      const useIncremental = diff && !diff.fallbackToFull && (diff.added.length + diff.modified.length + diff.deleted.length) > 0;

      let result;
      if (useIncremental) {
        const changedCount = diff.added.length + diff.modified.length;
        const deletedCount = diff.deleted.length;
        log(`  ${repo.name}: file diff → ${changedCount} changed, ${deletedCount} deleted (incremental)`);
        result = await chunkChangedFiles(repo.path, repo.name, project, config.chunking, diff);
        result.fileIndex = mergeFileIndex(meta?.files, result.fileIndex, diff.deleted);
        repoDiffs.set(repo.name, diff);
      } else {
        // Full re-chunk (first index or force)
        log(`  ${repo.name}: full chunk scan (${forceFullReason ?? `cached files: ${Object.keys(meta?.files ?? {}).length}`})`);
        result = await chunkRepo(repo.path, repo.name, project, config.chunking, forceFullReason ? undefined : meta?.files ?? undefined);
      }

      allChunks.push(...result.chunks);
      repoChunkResults.set(repo.name, result);
      const totalChunkCount = Object.values(result.fileIndex).reduce((sum: number, f: any) => sum + f.chunkCount, 0);
      log(`  ${repo.name}: chunk result -> ${result.changedFiles.length} changed files, ${result.deletedFiles.length} deleted files, ${result.chunks.length} chunks needing embedding, ${totalChunkCount} indexed chunks total`);
      log(`  ${repo.name}: chunk diagnostics -> ${formatChunkDiagnostics(result.diagnostics)}`);
      repoStats.push({ name: repo.name, chunkCount: totalChunkCount, language: repo.language });
    }
    for (const name of skippedRepos) {
      const meta = readRepoIndexMeta(basePath, name);
      repoStats.push({ name, chunkCount: meta?.chunkCount ?? 0, language: '' });
    }
    log(`Chunked ${allChunks.length} chunks from ${reposToIndex.length} repos`);
    const chunkLimit = maxIndexChunks();
    if (allChunks.length > chunkLimit) {
      throw new Error(`too many chunks to index: ${allChunks.length} exceeds CODE_SEARCH_MAX_CHUNKS=${chunkLimit}. Open a narrower directory or raise the limit.`);
    }

    // 4. Structural dedup (WS-6)
    report({ phase: 'dedup', message: 'Deduplicating chunks by structure...', percent: 25, etaSeconds: -1 });
    const dedupResult = deduplicateByStructure(allChunks);
    const uniqueChunks = dedupResult.unique;
    if (dedupResult.savings.chunks > 0) {
      log(`Structural dedup: ${dedupResult.savings.chunks} duplicates removed`);
    }

    // 5. Detect workspace structures
    const workspaceMaps = new Map<string, WorkspaceMap>();
    for (const repo of repos) {
      try {
        const wsMap = detectWorkspace(repo.path);
        if (wsMap.packages.length > 0) {
          workspaceMaps.set(repo.name, wsMap);
          log(`Detected workspace in ${repo.name}: ${wsMap.packages.length} packages`);
        }
      } catch (err) {
        log(`Warning: Workspace detection failed for ${repo.name}: ${err}`);
      }
    }

    // 6. Build AST graphs — incremental when possible via git diff
    report({ phase: 'graphing', message: 'Building AST graphs...', percent: 40, etaSeconds: -1 });
    const graphBuilder = new ProjectGraphBuilder();
    await graphBuilder.init();

    for (const repo of repos) {
      try {
        const repoKbDir = join(basePath, repo.name);
        mkdirSync(repoKbDir, { recursive: true });
        const existingGraphPath = join(repoKbDir, 'graph.json');
        const diff = repoDiffs.get(repo.name);

        let graph;
        if (diff && !diff.fallbackToFull && existsSync(existingGraphPath)) {
          // Incremental graph update — only re-parse changed files
          const existingGraph = JSON.parse(readFileSync(existingGraphPath, 'utf-8'));
          graph = await incrementalGraphUpdate(
            existingGraph,
            getChangedFilesList(diff),
            getDeletedFilesList(diff),
            repo.path,
            { workspaceMap: workspaceMaps.get(repo.name) },
          );
          log(`Updated AST graph for ${repo.name} incrementally (${diff.added.length + diff.modified.length} files changed)`);
        } else {
          // Full rebuild
          graph = await buildAstGraph(repo.path, { workspaceMap: workspaceMaps.get(repo.name) });
          log(`Built AST graph for ${repo.name} (${graph.nodes.length} nodes, ${graph.links.length} edges)`);
        }

        graphBuilder.addRepoGraph(repo.name, graph);
        writeFileSync(join(repoKbDir, 'graph.json'), JSON.stringify(graph));
        writeFileSync(join(repoKbDir, 'GRAPH_REPORT.md'), generateGraphReport(repo.name, graph));
      } catch (err) {
        log(`Warning: AST graph build failed for ${repo.name}: ${err}`);
      }
    }

    // 7. Detect cross-repo edges (14 strategies)
    report({ phase: 'graphing', message: 'Detecting cross-repo edges...', percent: 70, etaSeconds: -1 });
    let crossRepoEdgeCount = 0;
    const hasWorkspaces = workspaceMaps.size > 0;
    if (repos.length > 1 || hasWorkspaces) {
      const crossEdges = await detectCrossRepoEdges(repos, workspaceMaps);
      graphBuilder.addCrossRepoEdges(crossEdges);
      crossRepoEdgeCount = crossEdges.length;
      log(`Detected ${crossEdges.length} cross-repo edges`);
    }

    // 8. LLM Service Mesh Inference (WS-2) — skipped if LLM_MODE=none
    if (isLlmAvailable()) {
      report({ phase: 'service-mesh', message: 'Inferring service mesh from profiles...', percent: 80, etaSeconds: -1 });
      try {
        const profiles = loadAllProfiles(project);
        if (profiles.length > 0) {
          log(`Inferring service mesh from ${profiles.length} profiles...`);
          const meshEdges = await inferServiceMesh(profiles, {
            onProgress: (m) => {
              log(m);
              report({ phase: 'service-mesh', message: m, percent: 82, etaSeconds: -1 });
            },
          });
          if (meshEdges.length > 0) {
            graphBuilder.addCrossRepoEdges(meshEdges);
            crossRepoEdgeCount += meshEdges.length;
            log(`Service mesh: ${meshEdges.length} edges inferred`);
          }
        } else {
          log('No profiles found — skipping service mesh inference');
        }
      } catch (err) {
        log(`Warning: Service mesh inference failed (non-fatal): ${err}`);
      }
    } else {
      log('LLM service mesh inference disabled — skipping');
      report({ phase: 'service-mesh', message: 'Skipped (LLM disabled)', percent: 85, etaSeconds: -1 });
    }

    // 9. Community detection
    report({ phase: 'graphing', message: 'Detecting communities...', percent: 90, etaSeconds: -1 });
    graphBuilder.detectCommunities();

    // 10. Save project graph
    const graphOutputPath = join(basePath, 'system_graph_v2.json');
    writeFileSync(graphOutputPath, JSON.stringify(graphBuilder.exportJson(), null, 2));
    log(`Saved project graph to ${graphOutputPath}`);

    // 11. Save chunks to disk (for later embedding)
    const chunksPath = join(basePath, 'chunks.json');
    writeFileSync(chunksPath, JSON.stringify(uniqueChunks));
    log(`Saved ${uniqueChunks.length} chunks to ${chunksPath}`);

    // 11b. Save deleted files list (for incremental embedding cleanup)
    const allDeletedFiles: Array<{ repoName: string; filePath: string }> = [];
    for (const repo of reposToIndex) {
      const result = repoChunkResults.get(repo.name);
      if (result?.deletedFiles) {
        for (const f of result.deletedFiles) {
          allDeletedFiles.push({ repoName: repo.name, filePath: f });
        }
      }
    }
    const deletedPath = join(basePath, 'deleted_files.json');
    writeFileSync(deletedPath, JSON.stringify(allDeletedFiles));
    log(`Saved deleted file manifest: ${allDeletedFiles.length} file(s)`);

    // 12. Save per-repo metadata
    for (const repo of reposToIndex) {
      const sha = getRepoSha(repo.path);
      const result = repoChunkResults.get(repo.name);
      const totalChunkCount = result ? Object.values(result.fileIndex).reduce((sum: number, f: any) => sum + f.chunkCount, 0) : 0;
      if (sha) {
        writeRepoIndexMeta(basePath, repo.name, {
          lastIndexedSha: sha,
          lastIndexedAt: new Date().toISOString(),
          chunkCount: totalChunkCount,
          embeddingProvider: 'pending',
          embeddingFingerprint: expectedEmbeddingFingerprint,
          files: result?.fileIndex,
        });
        log(`Saved index metadata for ${repo.name}: ${totalChunkCount} chunks across ${Object.keys(result?.fileIndex ?? {}).length} files at ${sha.slice(0, 7)}`);
      }
    }

    const durationMs = Date.now() - startTime;
    report({ phase: 'done', message: `KB built: ${uniqueChunks.length} chunks, ${crossRepoEdgeCount} edges in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0, skippedRepos });

    return {
      project,
      repos: repoStats,
      totalChunks: uniqueChunks.length,
      totalTokens: uniqueChunks.reduce((sum, c) => sum + c.tokens, 0),
      crossRepoEdges: crossRepoEdgeCount,
      durationMs,
      chunksPath,
    };
  }

  // ---------------------------------------------------------------------------
  // EMBED — incremental: only embeds new/changed chunks, preserves existing.
  // ---------------------------------------------------------------------------

  async embedChunks(
    project: string,
    config: KnowledgeConfig,
    opts?: {
      onProgress?: (msg: string) => void;
      onDetailedProgress?: (progress: IndexProgress) => void;
    },
  ): Promise<IndexStats> {
    const log = opts?.onProgress ?? (() => {});
    const report = opts?.onDetailedProgress ?? (() => {});
    const startTime = Date.now();
    const basePath = getKnowledgeBasePath(project);

    // Load chunks from disk (only new/changed chunks from buildKB)
    const chunksPath = join(basePath, 'chunks.json');
    if (!existsSync(chunksPath)) {
      throw new Error(`No chunks found — run Build KB first. Expected: ${chunksPath}`);
    }
    const chunks: CodeChunk[] = JSON.parse(readFileSync(chunksPath, 'utf-8'));
    log(`Loaded ${chunks.length} chunks from ${chunksPath}`);

    // Open vector store
    const dbPath = join(basePath, 'lancedb');
    const vectorStore = new VectorStore(dbPath);
    await vectorStore.init();
    const embedder = createEmbeddingProvider(config.embedding);
    const embeddingFingerprint = embeddingFingerprintFromProvider(embedder);
    log(`Embedding with fingerprint: ${formatFingerprint(embeddingFingerprint)}`);

    const deletedFiles = this.getDeletedFiles(basePath);
    const changedFiles = this.getChangedFilesByRepo(basePath);
    const changedFileCount = [...changedFiles.values()].reduce((sum, files) => sum + files.length, 0);
    log(`Embedding plan input: ${chunks.length} chunk(s), ${changedFileCount} changed file(s), ${deletedFiles.length} deleted file(s)`);
    const reusableByKey = new Map<string, CodeChunk & { embedding: number[] }>();
    const changedFileKeys = new Set<string>();

    for (const [repoName, filePaths] of changedFiles) {
      for (const filePath of filePaths) {
        changedFileKeys.add(`${repoName}\0${filePath}`);
        for (const existing of await vectorStore.getChunksByFile(repoName, filePath)) {
          if (!existing.embedding || !existing.stableKey || !existing.embedHash) continue;
          reusableByKey.set(`${repoName}\0${filePath}\0${existing.stableKey}\0${existing.embedHash}`, existing as CodeChunk & { embedding: number[] });
        }
      }
    }
    log(`Loaded ${reusableByKey.size} reusable vector candidate(s) from changed files`);

    const existingIds = new Set<string>();
    try {
      const stats = await vectorStore.getStats();
      if (stats && stats.rowCount > 0) {
        const existingChunks = await vectorStore.getChunkIds(project);
        for (const id of existingChunks) existingIds.add(id);
      }
    } catch { /* first run — no existing data */ }

    const reusedChunks: Array<CodeChunk & { embedding: number[] }> = [];
    const newChunks: CodeChunk[] = [];

    for (const chunk of chunks) {
      const fileKey = `${chunk.repoName}\0${chunk.filePath}`;
      if (!changedFileKeys.has(fileKey)) {
        if (!existingIds.has(chunk.id)) newChunks.push(chunk);
        continue;
      }
      const reuseKey = `${chunk.repoName}\0${chunk.filePath}\0${chunk.stableKey ?? ''}\0${chunk.embedHash ?? ''}`;
      const reusable = reusableByKey.get(reuseKey);
      if (reusable) {
        reusedChunks.push({ ...chunk, embedding: reusable.embedding, dirty: false });
      } else {
        newChunks.push({ ...chunk, dirty: false });
      }
    }
    log(`Embedding diff: ${newChunks.length} chunk(s) need embedding, ${reusedChunks.length} chunk(s) reuse existing vectors`);

    if (newChunks.length === 0 && reusedChunks.length === 0 && deletedFiles.length === 0) {
      log('All chunks already embedded — nothing to do.');
      report({ phase: 'done', message: 'All chunks already embedded', percent: 100, etaSeconds: 0 });
      const repoNames = [...new Set(chunks.map((c) => c.repoName))];
      return {
        project,
        repos: repoNames.map((n) => ({ name: n, chunkCount: chunks.filter((c) => c.repoName === n).length, language: '' })),
        totalChunks: chunks.length,
        totalTokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
        embeddingProvider: 'cached',
        embeddingDimensions: 0,
        crossRepoEdges: 0,
        lastIndexed: new Date().toISOString(),
        indexDurationMs: Date.now() - startTime,
      };
    }

    // Prepare replacement targets. Changed files are deleted only after replacement rows are ready.
    const filesToDelete = [
      ...deletedFiles,
      ...[...changedFiles.entries()].flatMap(([repoName, filePaths]) => filePaths.map((filePath) => ({ repoName, filePath }))),
    ];

    // Embed only new/changed chunks
    const isOllama = embedder.name === 'ollama';
    const envBatchSize = parseInt(process.env.CODE_SEARCH_EMBEDDING_BATCH_SIZE ?? '', 10);
    const envBatchDelay = parseInt(process.env.CODE_SEARCH_EMBEDDING_BATCH_DELAY_MS ?? '', 10);
    const batchSize = Number.isFinite(envBatchSize) && envBatchSize > 0
      ? envBatchSize
      : isOllama ? 10 : 50;
    const batchDelay = Number.isFinite(envBatchDelay) && envBatchDelay >= 0
      ? envBatchDelay
      : isOllama ? 50 : 100;

    log(`Embedding ${newChunks.length} new chunks with ${embedder.name} (${reusedChunks.length} reused from changed files, ${chunks.length - newChunks.length - reusedChunks.length} cached/unchanged, batch size: ${batchSize}, delay: ${batchDelay}ms)...`);

    const texts = newChunks.map((c) => c.embedText ?? c.contextualizedContent);
    const embeddings: number[][] = [];
    const totalBatches = Math.ceil(texts.length / batchSize);
    let batchesDone = 0;
    const embedStartTime = Date.now();

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await embedder.embed(batch);
      embeddings.push(...batchEmbeddings);
      batchesDone++;

      const elapsed = Date.now() - embedStartTime;
      const msPerBatch = elapsed / batchesDone;
      const remainingBatches = totalBatches - batchesDone;
      const etaSeconds = Math.ceil((msPerBatch * remainingBatches) / 1000);
      const percent = Math.round(5 + (batchesDone / totalBatches) * 85);
      const processed = Math.min(i + batchSize, texts.length);

      report({
        phase: 'embedding',
        message: `Embedding: ${processed}/${texts.length} new (~${etaSeconds}s remaining)`,
        percent, etaSeconds,
        chunksTotal: texts.length, chunksProcessed: processed,
      });

      if (batchesDone % 10 === 0 || batchesDone === totalBatches) {
        log(`  Embedded ${processed}/${texts.length} (ETA: ${formatEta(etaSeconds)})`);
      }
      if (i + batchSize < texts.length && batchDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelay));
      }
    }

    const embeddedChunks = newChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));

    report({ phase: 'storing', message: 'Saving new chunks to vector database...', percent: 92, etaSeconds: -1 });

    // Replace old rows only after replacements are ready. VectorStore keeps backups and restores dirty rows if add fails.
    const rowsToStore = [...reusedChunks, ...embeddedChunks];
    if (filesToDelete.length > 0) {
      const byRepo = new Map<string, string[]>();
      for (const d of filesToDelete) {
        const list = byRepo.get(d.repoName) ?? [];
        list.push(d.filePath);
        byRepo.set(d.repoName, list);
      }
      for (const [repoName, filePaths] of byRepo) {
        log(`Replacing chunks for ${filePaths.length} changed/deleted files from ${repoName}: ${filePaths.slice(0, 8).join(', ')}${filePaths.length > 8 ? `, ... ${filePaths.length - 8} more` : ''}`);
      }
      try {
        const summary = await vectorStore.replaceFileChunks(project, filesToDelete, rowsToStore);
        log(`Vector replacement complete: deletedFiles=${summary.filesDeleted}, rowsAdded=${summary.rowsAdded}, backedUp=${summary.rowsBackedUp}, restored=${summary.rowsRestored}`);
      } catch (err) {
        const detail = err instanceof Error ? err.stack || err.message : String(err);
        log(`Vector replacement failed after preparing ${rowsToStore.length} replacement row(s); stale backups should have been restored when possible: ${detail}`);
        throw err;
      }
    } else if (rowsToStore.length > 0) {
      await vectorStore.addChunks(rowsToStore);
      log(`Vector append complete: rowsAdded=${rowsToStore.length}`);
    }
    log(`Stored ${embeddedChunks.length} new chunks and reused ${reusedChunks.length} chunks in LanceDB (${deletedFiles.length} removed)`);

    // Update metadata
    const repoNames = [...new Set(chunks.map((c) => c.repoName))];
    for (const repoName of repoNames) {
      const metaPath = join(basePath, repoName, 'index_meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          meta.embeddingProvider = embedder.name;
          meta.embeddingFingerprint = embeddingFingerprint;
          meta.lastIndexedAt = new Date().toISOString();
          writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        } catch { /* ok */ }
      }
    }

    const durationMs = Date.now() - startTime;
    report({ phase: 'done', message: `Embedded ${newChunks.length} new chunks (${deletedFiles.length} removed) in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0 });

    return {
      project,
      repos: repoNames.map((n) => ({ name: n, chunkCount: chunks.filter((c) => c.repoName === n).length, language: '' })),
      totalChunks: chunks.length,
      totalTokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
      embeddingProvider: embedder.name,
      embeddingDimensions: embedder.dimensions,
      crossRepoEdges: 0,
      lastIndexed: new Date().toISOString(),
      indexDurationMs: durationMs,
    };
  }

  /** Read the deleted files list saved by buildKB */
  private getDeletedFiles(basePath: string): Array<{ repoName: string; filePath: string }> {
    const deletedPath = join(basePath, 'deleted_files.json');
    if (!existsSync(deletedPath)) return [];
    try {
      return JSON.parse(readFileSync(deletedPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  private getChangedFilesByRepo(basePath: string): Map<string, string[]> {
    const changed = new Map<string, string[]>();
    const chunksPath = join(basePath, 'chunks.json');
    if (!existsSync(chunksPath)) return changed;
    try {
      const chunks = JSON.parse(readFileSync(chunksPath, 'utf-8')) as CodeChunk[];
      for (const chunk of chunks) {
        const list = changed.get(chunk.repoName) ?? [];
        if (!list.includes(chunk.filePath)) list.push(chunk.filePath);
        changed.set(chunk.repoName, list);
      }
    } catch {
      return changed;
    }
    return changed;
  }

  async markFilesDirty(project: string, files: Array<{ repoName: string; filePath: string }>, dirty: boolean = true): Promise<number> {
    const basePath = getKnowledgeBasePath(project);
    const dbPath = join(basePath, 'lancedb');
    const vectorStore = new VectorStore(dbPath);
    await vectorStore.init();
    return vectorStore.markFilesDirty(project, files, dirty);
  }

  checkFreshness(project: string, directoryPath: string, config: KnowledgeConfig = loadKnowledgeConfig(project)): FreshnessStatus {
    const basePath = getKnowledgeBasePath(project);
    const repos = discoverRepos(directoryPath);
    const expectedEmbeddingFingerprint = embeddingFingerprintFromProvider(createEmbeddingProvider(config.embedding));
    const result: FreshnessStatus = {
      stale: false,
      reason: 'current',
      reposChecked: repos.length,
      added: 0,
      modified: 0,
      deleted: 0,
      fingerprintMismatches: [],
      files: [],
    };

    for (const repo of repos) {
      const meta = readRepoIndexMeta(basePath, repo.name);
      if (!meta) {
        result.stale = true;
        result.reason = 'missing index metadata';
        continue;
      }

      if (!metaEmbeddingCompatible(meta, expectedEmbeddingFingerprint)) {
        result.stale = true;
        result.reason = 'embedding fingerprint mismatch';
        result.fingerprintMismatches.push(repo.name);
        for (const filePath of Object.keys(meta.files ?? {})) {
          result.files.push({ repoName: repo.name, filePath });
        }
        continue;
      }

      const diff = detectFileChanges(repo.path, meta.files);
      if (diff.fallbackToFull) {
        result.stale = true;
        result.reason = 'file metadata unavailable';
        continue;
      }
      result.added += diff.added.length;
      result.modified += diff.modified.length;
      result.deleted += diff.deleted.length;
      for (const filePath of [...diff.modified, ...diff.deleted]) {
        result.files.push({ repoName: repo.name, filePath });
      }
    }

    if (result.added + result.modified + result.deleted > 0) {
      result.stale = true;
      result.reason = `${result.added} added, ${result.modified} modified, ${result.deleted} deleted`;
    }

    return result;
  }

  fileNeedsRefresh(project: string, repoName: string, repoPath: string, filePath: string): boolean {
    const meta = readRepoIndexMeta(getKnowledgeBasePath(project), repoName);
    if (!meta?.files) return true;
    const cached = meta.files[filePath];
    if (!cached) return true;
    const fullPath = join(repoPath, filePath);
    if (!existsSync(fullPath)) return true;
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      return true;
    }
    if (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return false;
    const contentHash = hashFile(fullPath);
    return !contentHash || cached.contentHash !== contentHash;
  }

  // ---------------------------------------------------------------------------
  // FULL INDEX — convenience: buildKB + embedChunks in one call
  // ---------------------------------------------------------------------------

  async indexProject(
    project: string,
    repos: Array<{ name: string; path: string; language: string }>,
    config: KnowledgeConfig,
    opts?: {
      onProgress?: (msg: string) => void;
      onDetailedProgress?: (progress: IndexProgress) => void;
      force?: boolean;
    },
  ): Promise<IndexStats> {
    // Phase 1: Build KB (fast)
    await this.buildKB(project, repos, config, opts);

    // Phase 2: Embed (slow)
    return this.embedChunks(project, config, opts);
  }

  /** Load index statistics for a project */
  async getStats(project: string): Promise<IndexStats> {
    const basePath = getKnowledgeBasePath(project);
    const dbPath = join(basePath, 'lancedb');
    const store = new VectorStore(dbPath);
    await store.init();
    const stats = await store.getStats();

    // Read metadata from per-repo index_meta.json files
    let provider = 'unknown';
    let lastIndexed = '';
    const repos: Array<{ name: string; chunkCount: number; language: string }> = [];

    try {
      const { readdirSync } = await import('node:fs');
      for (const entry of readdirSync(basePath)) {
        const meta = readRepoIndexMeta(basePath, entry);
        if (meta) {
          repos.push({ name: entry, chunkCount: meta.chunkCount, language: '' });
          if (meta.embeddingProvider !== 'unknown') provider = meta.embeddingProvider;
          if (meta.lastIndexedAt > lastIndexed) lastIndexed = meta.lastIndexedAt;
        }
      }
    } catch { /* ignore */ }

    return {
      project,
      repos,
      totalChunks: stats?.rowCount ?? 0,
      totalTokens: 0,
      embeddingProvider: provider,
      embeddingDimensions: 0,
      crossRepoEdges: 0,
      lastIndexed,
      indexDurationMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Path-based discovery — NO YAML, NO config. Just a directory path.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'build', '__pycache__', '.venv', 'vendor', 'target']);

/**
 * Discover repos from a directory path. Zero config required.
 *
 * - If path IS a git repo → single repo
 * - If path CONTAINS git repos → multi-repo (scans subdirs)
 */
export function discoverRepos(directoryPath: string): Array<{ name: string; path: string; language: string }> {
  if (!existsSync(directoryPath)) return [];

  const repos: Array<{ name: string; path: string; language: string }> = [];

  // Check if directory itself is a git repo
  if (existsSync(join(directoryPath, '.git'))) {
    repos.push({
      name: basename(directoryPath),
      path: directoryPath,
      language: detectLanguage(directoryPath),
    });
    return repos;
  }

  // Scan subdirectories for git repos
  try {
    for (const entry of readdirSync(directoryPath)) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const fullPath = join(directoryPath, entry);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch { continue; }
      if (!existsSync(join(fullPath, '.git'))) continue;

      repos.push({
        name: entry,
        path: fullPath,
        language: detectLanguage(fullPath),
      });
    }
  } catch { /* ignore */ }

  return repos;
}

/** Detect primary language of a repo from manifest files and file extensions */
function detectLanguage(repoPath: string): string {
  // Manifest-based detection (most reliable)
  if (existsSync(join(repoPath, 'go.mod'))) return 'go';
  if (existsSync(join(repoPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) return 'java';
  if (existsSync(join(repoPath, 'composer.json'))) return 'php';
  if (existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'setup.py'))) return 'python';

  // Check package.json for TS vs JS
  if (existsSync(join(repoPath, 'package.json'))) {
    if (existsSync(join(repoPath, 'tsconfig.json'))) return 'typescript';
    return 'javascript';
  }

  return 'unknown';
}

/**
 * Build KB from a directory path — fast, no embedding.
 * Profiles repos, chunks files, builds AST graphs, detects cross-repo edges.
 * Saves chunks.json for later embedding.
 */
export async function buildKBFromPath(
  projectName: string,
  directoryPath: string,
  opts?: {
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
    force?: boolean;
  },
): Promise<BuildKBResult> {
  const log = opts?.onProgress ?? (() => {});
  ensureIndexIgnore(directoryPath);
  log(`Scanning ${directoryPath} for repos...`);
  const repos = discoverRepos(directoryPath);
  if (repos.length === 0) throw new Error(`No git repos found in ${directoryPath}`);
  log(`Discovered ${repos.length} repos`);
  const indexer = new KnowledgeIndexer();
  return indexer.buildKB(projectName, repos, loadKnowledgeConfig(projectName), opts);
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path, 'utf-8')).digest('hex');
  } catch {
    return null;
  }
}

function detectFileChanges(repoPath: string, cachedFiles?: Record<string, FileIndexEntry>): GitDiff {
  if (!cachedFiles) return { added: [], modified: [], deleted: [], renamed: [], fallbackToFull: true };
  const files: string[] = [];
  walkDir(repoPath, files);
  const current = new Set(files.map((file) => relative(repoPath, file)));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const file of files) {
    const relPath = relative(repoPath, file);
    const cached = cachedFiles[relPath];
    if (!cached) {
      added.push(relPath);
      continue;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      deleted.push(relPath);
      continue;
    }
    if (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    const contentHash = hashFile(file);
    if (!contentHash || cached.contentHash !== contentHash) modified.push(relPath);
  }

  for (const relPath of Object.keys(cachedFiles)) {
    if (!current.has(relPath)) deleted.push(relPath);
  }

  return { added, modified, deleted, renamed: [], fallbackToFull: false };
}

function mergeFileIndex(
  previous: Record<string, FileIndexEntry> | undefined,
  changed: Record<string, FileIndexEntry>,
  deleted: string[],
): Record<string, FileIndexEntry> {
  const merged: Record<string, FileIndexEntry> = { ...(previous ?? {}) };
  for (const relPath of deleted) delete merged[relPath];
  for (const [relPath, entry] of Object.entries(changed)) merged[relPath] = entry;
  return merged;
}

/**
 * Embed chunks for a project that already has KB built.
 * Reads chunks.json, embeds with Ollama bge-m3, stores in LanceDB.
 */
export async function embedFromPath(
  projectName: string,
  opts?: {
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
  },
): Promise<IndexStats> {
  const indexer = new KnowledgeIndexer();
  return indexer.embedChunks(projectName, loadKnowledgeConfig(projectName), opts);
}

/**
 * Full index from a directory path — buildKB + embed in one call.
 */
export async function indexFromPath(
  projectName: string,
  directoryPath: string,
  opts?: {
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
    force?: boolean;
  },
): Promise<IndexStats> {
  const log = opts?.onProgress ?? (() => {});
  ensureIndexIgnore(directoryPath);
  log(`Scanning ${directoryPath} for repos...`);
  const repos = discoverRepos(directoryPath);
  if (repos.length === 0) throw new Error(`No git repos found in ${directoryPath}`);
  log(`Discovered ${repos.length} repos`);
  const indexer = new KnowledgeIndexer();
  return indexer.indexProject(projectName, repos, loadKnowledgeConfig(projectName), opts);
}

function formatEta(seconds: number): string {
  if (seconds < 0) return '...';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// ---------------------------------------------------------------------------
// Convenience: get a ready-to-use retriever for an already-indexed project
// ---------------------------------------------------------------------------

/** Load an existing index and return a configured HybridRetriever with query routing. */
export async function getRetriever(project: string): Promise<HybridRetriever> {
  const config = loadKnowledgeConfig(project);
  const basePath = getKnowledgeBasePath(project);

  // Load vector store
  const dbPath = join(basePath, 'lancedb');
  const vectorStore = new VectorStore(dbPath);
  await vectorStore.init();

  // Load project graph (if available)
  let graph: ProjectGraphBuilder | null = null;
  const graphPath = join(basePath, 'system_graph_v2.json');
  if (existsSync(graphPath)) {
    try {
      const graphData = JSON.parse(readFileSync(graphPath, 'utf-8'));
      graph = new ProjectGraphBuilder();
      await graph.importJson(graphData);
    } catch {
      // Proceed without graph — vector + BM25 still work
    }
  }

  // Create embedding provider for query-time embedding
  const embedder = createEmbeddingProvider(config.embedding);

  // Create reranker (ollama by default, graceful fallback)
  let reranker = null;
  try {
    const { createReranker } = await import('./reranker.js');
    reranker = createReranker(config.retrieval.reranker);
  } catch {
    // Reranker module unavailable — proceed without
  }

  // Create query router (WS-8) — routes queries to relevant repos
  let queryRouter = null;
  try {
    queryRouter = await createQueryRouter(project, embedder);
    if (queryRouter) {
      // eslint-disable-next-line no-console
      console.log(`[knowledge] Query router ready (${queryRouter.repoCount} repo profiles)`);
    }
  } catch {
    // Query routing unavailable — search all repos
  }

  return new HybridRetriever(vectorStore, embedder, graph, {
    maxChunks: config.retrieval.maxChunks,
    maxTokens: config.retrieval.maxTokens,
    hybridWeights: config.retrieval.hybridWeights,
  }, reranker, queryRouter);
}
