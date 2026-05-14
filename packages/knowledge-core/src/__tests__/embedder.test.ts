import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleEmbedder } from '../embedder.js';

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
