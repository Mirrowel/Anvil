#!/usr/bin/env node

const query = 'Where is authentication token validation implemented?';
const documents = [
  'export function validateToken(token) { return token && token.startsWith("Bearer "); }',
  'function renderButton(label) { return `<button>${label}</button>`; }',
  'The cache invalidation task removes expired records every hour.',
  'authMiddleware reads the Authorization header and calls validateToken before routing.',
];

function printResult(provider, payload) {
  console.log(JSON.stringify({ provider, payload }, null, 2));
}

async function probeCohere() {
  const apiKey = process.env.CO_API_KEY || process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('Set CO_API_KEY or COHERE_API_KEY');

  const response = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.COHERE_RERANK_MODEL || 'rerank-v4.0-pro',
      query,
      top_n: 4,
      documents,
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Cohere ${response.status}: ${text}`);
  const json = JSON.parse(text);
  printResult('cohere', json.results?.map((r) => ({ index: r.index, score: r.relevance_score, doc: documents[r.index] })) ?? json);
}

async function probeNvidia() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('Set NVIDIA_API_KEY');

  const response = await fetch('https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.NVIDIA_RERANK_MODEL || 'nv-rerank-qa-mistral-4b:1',
      query: { text: query },
      passages: documents.map((text) => ({ text })),
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`NVIDIA ${response.status}: ${text}`);
  const json = JSON.parse(text);
  const rankings = json.rankings || json.results || json.data || json;
  const normalized = Array.isArray(rankings)
    ? rankings.map((r) => {
        const index = r.index ?? r.passage_index ?? r.document_index ?? r.id;
        return { index, score: r.score ?? r.relevance_score ?? r.logit, doc: documents[index] };
      })
    : rankings;
  printResult('nvidia', normalized);
}

const provider = process.argv[2];
try {
  if (provider === 'cohere') await probeCohere();
  else if (provider === 'nvidia') await probeNvidia();
  else {
    console.error('Usage: node packages/knowledge-core/scripts/probe-rerankers.mjs <cohere|nvidia>');
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
