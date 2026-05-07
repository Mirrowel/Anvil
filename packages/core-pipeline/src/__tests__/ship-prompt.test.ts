/**
 * Tests for the ship prompt builder + URL extraction helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShipUserPrompt, extractPrUrls, extractSandboxUrl } from '../stages/ship.js';

describe('buildShipUserPrompt', () => {
  it('renders the PR-creation prompt', () => {
    const prompt = buildShipUserPrompt({
      feature: 'Add pet shelter',
      featureSlug: 'add-pet-shelter',
      repoNames: ['backend', 'frontend'],
      workspaceDir: '/work',
    });
    assert.match(prompt, /Push feature branch \+ open PR/);
    assert.match(prompt, /gh pr create/);
    assert.match(prompt, /anvil\/add-pet-shelter/);
    assert.match(prompt, /backend, frontend/);
    assert.doesNotMatch(prompt, /sandbox_create/);
  });

  it('uses the PR label set per actionType', () => {
    const featurePr = buildShipUserPrompt({
      feature: 'F', featureSlug: 'f', repoNames: ['r'], workspaceDir: '/w',
      actionType: 'feature',
    });
    assert.match(featurePr, /--label "anvil" --label "enhancement"/);

    const bugPr = buildShipUserPrompt({
      feature: 'F', featureSlug: 'f', repoNames: ['r'], workspaceDir: '/w',
      actionType: 'bugfix',
    });
    assert.match(bugPr, /--label "anvil" --label "bug"/);

    const spikePr = buildShipUserPrompt({
      feature: 'F', featureSlug: 'f', repoNames: ['r'], workspaceDir: '/w',
      actionType: 'spike',
    });
    assert.match(spikePr, /--label "anvil" --label "spike"/);
  });

});

describe('extractPrUrls', () => {
  it('finds GitHub PR urls in mixed output', () => {
    const out = `Created the PR.
See https://github.com/foo/bar/pull/42 and https://github.com/foo/baz/pull/43.
Done.`;
    assert.deepEqual(extractPrUrls(out).sort(), [
      'https://github.com/foo/bar/pull/42',
      'https://github.com/foo/baz/pull/43',
    ]);
  });
  it('deduplicates', () => {
    const out = 'https://github.com/x/y/pull/1 and again https://github.com/x/y/pull/1';
    assert.deepEqual(extractPrUrls(out), ['https://github.com/x/y/pull/1']);
  });
  it('returns [] on empty', () => {
    assert.deepEqual(extractPrUrls(''), []);
  });
});

describe('extractSandboxUrl', () => {
  it('parses SANDBOX_URL=<url> on its own line', () => {
    const out = `Done.\nSANDBOX_URL=https://nexus.example.com/sb/abc\n`;
    assert.equal(extractSandboxUrl(out), 'https://nexus.example.com/sb/abc');
  });
  it('returns undefined when missing', () => {
    assert.equal(extractSandboxUrl('no url here'), undefined);
  });
  it('ignores SANDBOX_URL inside other text (not at line start)', () => {
    assert.equal(extractSandboxUrl('see SANDBOX_URL=https://x in the doc'), undefined);
  });
});
