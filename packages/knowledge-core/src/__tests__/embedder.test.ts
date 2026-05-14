import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CohereEmbedder,
  NvidiaEmbedder,
  OpenAICompatibleEmbedder,
  createEmbeddingProvider,
} from '../embedder.js';

const originalFetch = globalThis.fetch;
const originalNvidiaKey = process.env.NVIDIA_API_KEY;
const originalCohereKey = process.env.COHERE_API_KEY;
const originalCoKey = process.env.CO_API_KEY;

function restoreEnv(): void {
  if (originalNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = originalNvidiaKey;
  if (originalCohereKey === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = originalCohereKey;
  if (originalCoKey === undefined) delete process.env.CO_API_KEY;
  else process.env.CO_API_KEY = originalCoKey;
}

describe('OpenAICompatibleEmbedder URL validation', () => {
  const originalAllow = process.env.CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS;

  afterEach(() => {
    if (originalAllow === undefined) delete process.env.CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS;
    else process.env.CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS = originalAllow;
  });

  it('rejects private non-loopback hosts by default', () => {
    assert.throws(
      () => new OpenAICompatibleEmbedder({ baseUrl: 'http://192.168.1.20:8000', model: 'embed', dimensions: 3 }),
      /private or reserved/,
    );
  });

  it('allows loopback hosts', () => {
    assert.doesNotThrow(
      () => new OpenAICompatibleEmbedder({ baseUrl: 'http://127.0.0.1:8000', model: 'embed', dimensions: 3 }),
    );
  });

  it('allows private hosts with explicit override', () => {
    process.env.CODE_SEARCH_ALLOW_PRIVATE_EMBEDDING_URLS = '1';
    assert.doesNotThrow(
      () => new OpenAICompatibleEmbedder({ baseUrl: 'http://192.168.1.20:8000', model: 'embed', dimensions: 3 }),
    );
  });
});

describe('NvidiaEmbedder', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('uses nv-embedcode defaults from the factory', () => {
    const provider = createEmbeddingProvider({ provider: 'nvidia' });
    assert.equal(provider.name, 'nvidia');
    assert.equal(provider.model, 'nvidia/nv-embedcode-7b-v1');
    assert.equal(provider.dimensions, 4096);
  });

  it('embeds indexed texts in passage mode', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-test-key';
    let requestBody: any;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        data: [
          { object: 'embedding', embedding: [1, 2, 3], index: 0 },
          { object: 'embedding', embedding: [4, 5, 6], index: 1 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const provider = new NvidiaEmbedder({ dimensions: 3 });
    const vectors = await provider.embed(['first', 'second']);

    assert.deepEqual(requestBody, {
      model: 'nvidia/nv-embedcode-7b-v1',
      input: ['first', 'second'],
      input_type: 'passage',
      encoding_format: 'float',
      truncate: 'NONE',
    });
    assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
  });

  it('embeds query text in query mode', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-test-key';
    let requestBody: any;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        data: [{ object: 'embedding', embedding: [7, 8, 9], index: 0 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const provider = new NvidiaEmbedder({ dimensions: 3 });
    const vector = await provider.embedSingle('find auth middleware');

    assert.equal(requestBody.input_type, 'query');
    assert.deepEqual(requestBody.input, ['find auth middleware']);
    assert.deepEqual(vector, [7, 8, 9]);
  });
});

describe('CohereEmbedder', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('uses embed-v4 defaults from the factory', () => {
    const provider = createEmbeddingProvider({ provider: 'cohere' });
    assert.equal(provider.name, 'cohere');
    assert.equal(provider.model, 'embed-v4.0');
    assert.equal(provider.dimensions, 1536);
  });

  it('embeds indexed texts as search documents', async () => {
    process.env.COHERE_API_KEY = 'cohere-test-key';
    let requestBody: any;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: { float: [[1, 2, 3], [4, 5, 6]] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const provider = new CohereEmbedder({ dimensions: 3 });
    const vectors = await provider.embed(['first', 'second']);

    assert.deepEqual(requestBody, {
      model: 'embed-v4.0',
      texts: ['first', 'second'],
      input_type: 'search_document',
      embedding_types: ['float'],
    });
    assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
  });

  it('embeds query text as a search query', async () => {
    process.env.COHERE_API_KEY = 'cohere-test-key';
    let requestBody: any;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: { float: [[7, 8, 9]] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const provider = new CohereEmbedder({ dimensions: 3 });
    const vector = await provider.embedSingle('find auth middleware');

    assert.equal(requestBody.input_type, 'search_query');
    assert.deepEqual(requestBody.texts, ['find auth middleware']);
    assert.deepEqual(vector, [7, 8, 9]);
  });
});
