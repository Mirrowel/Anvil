import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import type { EmbeddingProvider } from '@esankhan3/anvil-knowledge-core';

const DEFAULT_EMBEDDING_TIMEOUT_MS = 25_000;
const DEFAULT_EMBEDDING_MAX_RETRIES = 3;

function embeddingTimeoutMs(): number {
  const raw = Number.parseInt(process.env.CODE_SEARCH_EMBEDDING_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMBEDDING_TIMEOUT_MS;
}

function embeddingMaxRetries(): number {
  const raw = Number.parseInt(process.env.CODE_SEARCH_EMBEDDING_MAX_RETRIES ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EMBEDDING_MAX_RETRIES;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(60_000, seconds * 1000);
  }
  return Math.min(60_000, 500 * 2 ** attempt);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  const maxRetries = embeddingMaxRetries();
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), embeddingTimeoutMs());
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) return response;
      await sleep(retryDelayMs(attempt, response.headers.get('retry-after')));
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      await sleep(retryDelayMs(attempt, null));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function validateEmbeddings(vectors: number[][], expectedCount: number, expectedDimensions: number, label: string): number[][] {
  if (vectors.length !== expectedCount) {
    throw new Error(`${label} returned ${vectors.length} vectors for ${expectedCount} inputs`);
  }
  if (vectors.length === 0) return vectors;
  const firstDim = vectors[0]?.length ?? 0;
  if (firstDim === 0) throw new Error(`${label} returned empty embedding vectors`);
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== firstDim) {
      throw new Error(`${label} returned inconsistent dimensions: vector 0 has ${firstDim}, vector ${i} has ${vectors[i].length}`);
    }
    if (expectedDimensions > 0 && vectors[i].length !== expectedDimensions) {
      throw new Error(`${label} returned dimension ${vectors[i].length}, expected ${expectedDimensions}`);
    }
  }
  return vectors;
}

function normalizeBaseUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(`${label} base URL is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} base URL must use http or https`);
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateBaseUrlNoPrivateNetwork(raw: string, label: string): void {
  if (process.env.CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS === '1') return;
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) return;
  if (host.endsWith('.local')) {
    throw new Error(`${label} base URL host "${host}" is an mDNS/private-network name. Set CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS=1 to allow it.`);
  }
  if (isPrivateNonLoopbackHost(host)) {
    throw new Error(`${label} base URL host "${host}" is private or reserved. Set CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS=1 to allow it.`);
  }
}

function isPrivateNonLoopbackHost(host: string): boolean {
  if (host === '0.0.0.0') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = octets;
    if (a === 127) return false;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
      || a === 0;
  }
  if (host === '::1') return false;
  const compact = host.replace(/^0+/, '').toLowerCase();
  return compact.startsWith('fe80:')
    || compact.startsWith('fc')
    || compact.startsWith('fd')
    || compact === '::'
    || compact.startsWith('::ffff:10.')
    || compact.startsWith('::ffff:192.168.')
    || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(compact);
}

// ---------------------------------------------------------------------------
// 1. Codestral (Mistral) Embedder
// ---------------------------------------------------------------------------

export class CodestralEmbedder implements EmbeddingProvider {
  readonly name = 'codestral';
  readonly dimensions: number;
  readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'codestral-embed-2505';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY environment variable is not set');
    }

    const response = await fetchWithRetry('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        encoding_format: 'float',
      }),
    }, 'Codestral embedding');

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Codestral embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return validateEmbeddings(json.data.map((d) => d.embedding), texts.length, this.dimensions, 'Codestral embedding');
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 2. Voyage Embedder
// ---------------------------------------------------------------------------

export class VoyageEmbedder implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions: number;
  readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'voyage-code-3';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY environment variable is not set');
    }

    const response = await fetchWithRetry('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: 'document',
      }),
    }, 'Voyage embedding');

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return validateEmbeddings(json.data.map((d) => d.embedding), texts.length, this.dimensions, 'Voyage embedding');
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 3. OpenAI Embedder
// ---------------------------------------------------------------------------

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'text-embedding-3-large';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetchWithRetry('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    }, 'OpenAI embedding');

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return validateEmbeddings(json.data.map((d) => d.embedding), texts.length, this.dimensions, 'OpenAI embedding');
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 4. Ollama Embedder (local, free)
// ---------------------------------------------------------------------------

/** Models that require task-specific prefixes for best performance */
const OLLAMA_PREFIX_MODELS: Record<string, { document: string; query: string }> = {
  'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' },
};

/** Default dimensions per known model (used when not explicitly configured) */
const OLLAMA_MODEL_DIMS: Record<string, number> = {
  'bge-m3': 1024,
  'nomic-embed-text': 768,
  'snowflake-arctic-embed:l': 1024,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

export class OllamaEmbedder implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions: number;
  readonly model: string;
  readonly baseUrl: string;
  private readonly prefixes: { document: string; query: string } | null;
  readonly documentPrefix?: string;
  readonly queryPrefix?: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'bge-m3';
    this.dimensions = options?.dimensions ?? OLLAMA_MODEL_DIMS[this.model] ?? 1024;
    this.baseUrl = normalizeBaseUrl(process.env.OLLAMA_HOST ?? 'http://localhost:11434', 'Ollama');
    this.prefixes = OLLAMA_PREFIX_MODELS[this.model] ?? null;
    this.documentPrefix = this.prefixes?.document;
    this.queryPrefix = this.prefixes?.query;
  }

  /** Embed texts as documents (for indexing) */
  async embed(texts: string[]): Promise<number[][]> {
    const prefixed = this.prefixes
      ? texts.map((t) => `${this.prefixes!.document}${t}`)
      : texts;
    return this._rawEmbed(prefixed);
  }

  /** Embed a single text as a query (for search) */
  async embedSingle(text: string): Promise<number[]> {
    const prefixed = this.prefixes ? `${this.prefixes.query}${text}` : text;
    const [result] = await this._rawEmbed([prefixed]);
    return result;
  }

  private async _rawEmbed(texts: string[]): Promise<number[][]> {
    const response = await fetchWithRetry(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    }, 'Ollama embedding');

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { embeddings: number[][] };
    return validateEmbeddings(json.embeddings, texts.length, this.dimensions, 'Ollama embedding');
  }
}

// ---------------------------------------------------------------------------
// 5. Gemini OAuth Embedder (uses Gemini CLI's stored OAuth token)
// ---------------------------------------------------------------------------

export class GeminiOAuthEmbedder implements EmbeddingProvider {
  readonly name = 'gemini-oauth';
  readonly dimensions: number;
  readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'text-embedding-004';
    this.dimensions = options?.dimensions ?? 768;
  }

  private getAccessToken(): string {
    const oauthPath = pathJoin(osHomedir(), '.gemini', 'oauth_creds.json');
    if (!fsExistsSync(oauthPath)) {
      throw new Error('Gemini CLI not authenticated. Run: gemini auth login');
    }
    const creds = JSON.parse(fsReadFileSync(oauthPath, 'utf-8'));
    if (!creds.access_token) {
      throw new Error('Gemini OAuth token not found. Run: gemini auth login');
    }
    return creds.access_token;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const token = this.getAccessToken();
    const results: number[][] = [];

    // Gemini embedding API processes one text at a time via batchEmbedContents
    const response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType: 'RETRIEVAL_DOCUMENT',
          })),
        }),
      },
      'Gemini embedding',
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini embedding request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as { embeddings: Array<{ values: number[] }> };
    for (const emb of json.embeddings) {
      results.push(emb.values);
    }
    return validateEmbeddings(results, texts.length, this.dimensions, 'Gemini embedding');
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 6. OpenAI-compatible Embedder (works with any embeddings API)
//
// Supports: OpenAI, Mistral, Together, Fireworks, OpenRouter, Jina,
//           local vLLM, LM Studio, llama.cpp, text-embeddings-inference, etc.
//
// Config via env:
//   CODE_SEARCH_EMBEDDING_BASE_URL   — API base URL (required)
//   CODE_SEARCH_EMBEDDING_API_KEY    — API key
//   CODE_SEARCH_EMBEDDING_MODEL      — model name (required)
// ---------------------------------------------------------------------------

export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly name = 'openai-compatible';
  readonly dimensions: number;
  readonly model: string;
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options?: { model?: string; dimensions?: number; baseUrl?: string; apiKey?: string }) {
    const baseUrl = options?.baseUrl || process.env.CODE_SEARCH_EMBEDDING_BASE_URL || '';
    this.baseUrl = baseUrl ? normalizeBaseUrl(baseUrl, 'OpenAI-compatible embedding') : '';
    this.model = options?.model || process.env.CODE_SEARCH_EMBEDDING_MODEL || '';
    this.apiKey = options?.apiKey || process.env.CODE_SEARCH_EMBEDDING_API_KEY;
    this.dimensions = options?.dimensions ?? 1024;

    if (!this.baseUrl) throw new Error('Embedding base URL required. Set CODE_SEARCH_EMBEDDING_BASE_URL');
    if (!this.model) throw new Error('Embedding model required. Set CODE_SEARCH_EMBEDDING_MODEL');
    validateBaseUrlNoPrivateNetwork(this.baseUrl, 'OpenAI-compatible embedding');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const endpoint = this.baseUrl.endsWith('/v1') ? `${this.baseUrl}/embeddings` : `${this.baseUrl}/v1/embeddings`;
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
        encoding_format: 'float',
      }),
    }, 'OpenAI-compatible embedding');

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return validateEmbeddings(json.data.map((d) => d.embedding), texts.length, this.dimensions, 'OpenAI-compatible embedding');
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Check if Gemini CLI is authenticated and has a valid OAuth token.
 */
function isGeminiCliAuthenticated(): boolean {
  try {
    const oauthPath = pathJoin(osHomedir(), '.gemini', 'oauth_creds.json');
    if (!fsExistsSync(oauthPath)) return false;
    const creds = JSON.parse(fsReadFileSync(oauthPath, 'utf-8'));
    return !!creds.access_token;
  } catch {
    return false;
  }
}

export function createEmbeddingProvider(config: {
  provider: string;
  model?: string;
  dimensions?: number;
}): EmbeddingProvider {
  const opts = { model: config.model, dimensions: config.dimensions };

  switch (config.provider) {
    case 'codestral':
    case 'mistral':
      return new CodestralEmbedder(opts);
    case 'voyage':
      return new VoyageEmbedder(opts);
    case 'openai':
      return new OpenAIEmbedder(opts);
    case 'ollama':
      return new OllamaEmbedder(opts);
    case 'gemini-oauth':
    case 'gemini':
      return new GeminiOAuthEmbedder(opts);
    case 'openai-compatible':
    case 'custom':
      return new OpenAICompatibleEmbedder(opts);
    case 'auto': {
      // Auto-detect: custom base URL → API keys → CLI OAuth → local Ollama.
      // Ollama availability is validated by the embedding request itself to avoid shelling out.
      if (process.env.CODE_SEARCH_EMBEDDING_BASE_URL) return new OpenAICompatibleEmbedder(opts);
      if (process.env.MISTRAL_API_KEY) return new CodestralEmbedder(opts);
      if (process.env.OPENAI_API_KEY) return new OpenAIEmbedder(opts);
      if (process.env.VOYAGE_API_KEY) return new VoyageEmbedder(opts);
      if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
        return new GeminiOAuthEmbedder(opts);
      }
      if (isGeminiCliAuthenticated()) return new GeminiOAuthEmbedder(opts);
      return new OllamaEmbedder(opts);
    }
    default:
      throw new Error(
        `Unknown embedding provider "${config.provider}". ` +
          'Supported: codestral, mistral, voyage, openai, ollama, gemini, openai-compatible, custom, auto',
      );
  }
}

// ---------------------------------------------------------------------------
// Batch helper
// ---------------------------------------------------------------------------

export async function batchEmbed(
  provider: EmbeddingProvider,
  texts: string[],
  batchSize: number = 50,
  delayMs: number = 100,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await provider.embed(batch);
    results.push(...embeddings);

    // Delay between batches to respect rate limits (skip after last batch)
    if (i + batchSize < texts.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
