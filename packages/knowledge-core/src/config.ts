import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface KnowledgeConfig {
  embedding: {
    provider:
      | 'codestral'
      | 'mistral'
      | 'voyage'
      | 'openai'
      | 'nomic-local'
      | 'ollama'
      | 'gemini'
      | 'gemini-oauth'
      | 'openai-compatible'
      | 'custom'
      | 'auto';
    model?: string;
    dimensions?: number;
    apiKeyEnv?: string;
  };
  chunking: {
    maxTokens: number;
    contextEnrichment: 'structural' | 'llm' | 'none';
  };
  retrieval: {
    maxChunks: number;
    maxTokens: number;
    hybridWeights: { vector: number; bm25: number; graph: number };
    reranker: 'cohere' | 'nvidia' | 'voyage' | 'ollama' | 'openai-compatible' | 'custom' | 'none';
  };
  autoIndex: boolean;
}

export const DEFAULT_CONFIG: KnowledgeConfig = {
  embedding: { provider: 'auto', dimensions: 1024 },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: {
    // Phase 6 — with the cross-encoder rerank default-on, the retriever can
    // emit a much tighter top-K with equal precision: the reranker picks the
    // best 8 from the larger fused+AST candidate pool (~15+ chunks). Override
    // via project.yaml when callers want a wider window.
    maxChunks: 8,
    maxTokens: 12000,
    hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 },
    reranker: 'ollama',
  },
  autoIndex: true,
};

function cloneDefaultConfig(): KnowledgeConfig {
  return {
    embedding: { ...DEFAULT_CONFIG.embedding },
    chunking: { ...DEFAULT_CONFIG.chunking },
    retrieval: {
      ...DEFAULT_CONFIG.retrieval,
      hybridWeights: { ...DEFAULT_CONFIG.retrieval.hybridWeights },
    },
    autoIndex: DEFAULT_CONFIG.autoIndex,
  };
}

function applyEnvOverrides(config: KnowledgeConfig): KnowledgeConfig {
  const embeddingProvider = process.env.CODE_SEARCH_EMBEDDING_PROVIDER;
  const embeddingModel = process.env.CODE_SEARCH_EMBEDDING_MODEL;
  const embeddingDimensions = process.env.CODE_SEARCH_EMBEDDING_DIMENSIONS;
  const embeddingApiKey = process.env.CODE_SEARCH_EMBEDDING_API_KEY;
  const rerankerProvider = process.env.CODE_SEARCH_RERANKER_PROVIDER;

  if (embeddingProvider) {
    config.embedding.provider = embeddingProvider as KnowledgeConfig['embedding']['provider'];
  }
  if (embeddingModel) config.embedding.model = embeddingModel;
  if (embeddingDimensions) config.embedding.dimensions = parseInt(embeddingDimensions, 10);

  if (embeddingApiKey) {
    const provider = config.embedding.provider;
    if (provider === 'codestral' || provider === 'mistral') {
      process.env.MISTRAL_API_KEY ??= embeddingApiKey;
    } else if (provider === 'openai') {
      process.env.OPENAI_API_KEY ??= embeddingApiKey;
    } else if (provider === 'voyage') {
      process.env.VOYAGE_API_KEY ??= embeddingApiKey;
    } else if (provider === 'openai-compatible' || provider === 'custom') {
      process.env.CODE_SEARCH_EMBEDDING_API_KEY ??= embeddingApiKey;
    }
  }

  if (rerankerProvider) {
    config.retrieval.reranker = rerankerProvider as KnowledgeConfig['retrieval']['reranker'];
  }

  return config;
}

/** Load knowledge config from factory.yaml, merging with defaults */
export function loadKnowledgeConfig(project: string): KnowledgeConfig {
  const anvilHome = process.env.ANVIL_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      return applyEnvOverrides(parseKnowledgeSection(raw));
    } catch { /* use defaults */ }
  }
  return applyEnvOverrides(cloneDefaultConfig());
}

function parseKnowledgeSection(yaml: string): KnowledgeConfig {
  // Minimal YAML parsing for knowledge section
  const config = cloneDefaultConfig();

  // Parse embedding provider
  const providerMatch = yaml.match(/^\s{4}provider:\s+(\S+)/m);
  if (providerMatch) {
    config.embedding = { ...config.embedding, provider: providerMatch[1] as any };
  }

  // Parse embedding model
  const modelMatch = yaml.match(/^\s{4}model:\s+(\S+)/m);
  if (modelMatch) config.embedding.model = modelMatch[1];

  // Parse dimensions
  const dimMatch = yaml.match(/^\s{4}dimensions:\s+(\d+)/m);
  if (dimMatch) config.embedding.dimensions = parseInt(dimMatch[1], 10);

  // Parse chunking max_tokens
  const chunkMatch = yaml.match(/^\s{4}max_tokens:\s+(\d+)/m);
  if (chunkMatch) config.chunking.maxTokens = parseInt(chunkMatch[1], 10);

  // Parse context_enrichment
  const enrichMatch = yaml.match(/^\s{4}context_enrichment:\s+(\S+)/m);
  if (enrichMatch) config.chunking.contextEnrichment = enrichMatch[1] as any;

  // Parse auto_index
  const autoMatch = yaml.match(/^\s{2}auto_index:\s+(true|false)/m);
  if (autoMatch) config.autoIndex = autoMatch[1] === 'true';

  return config;
}

/**
 * Get the knowledge base storage path for a project.
 *
 * Resolution order (matches both consumer behaviors):
 *   1. CODE_SEARCH_DATA_DIR — used by mcp's docker / production deployments
 *   2. ANVIL_HOME / 'knowledge-base' — cli's default
 *   3. ~/.anvil/knowledge-base — fallback when neither env var is set
 */
export function getKnowledgeBasePath(project: string): string {
  // CODE_SEARCH_DATA_DIR takes priority (Docker / production)
  const dataDir = process.env.CODE_SEARCH_DATA_DIR;
  if (dataDir) return join(dataDir, project);

  const anvilHome = process.env.ANVIL_HOME || join(homedir(), '.anvil');
  return join(anvilHome, 'knowledge-base', project);
}
