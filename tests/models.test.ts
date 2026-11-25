import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelCatalog, ModelCatalogEntry } from '../src/cloud-direct/index.js';
import { buildLiveModels, FALLBACK_MODELS, resolveDevinTarget } from '../src/models.js';

const catalog = (...entries: ModelCatalogEntry[]): ModelCatalog => ({
  byUid: new Map(entries.map((e) => [e.modelUid, e])),
  fetchedAt: Date.now(),
});
const entry = (modelUid: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  modelUid,
  label: modelUid,
  disabled: false,
  ...extra,
});

function chatModel(models: ReturnType<typeof buildLiveModels>, id: string) {
  const model = models.find((m) => m.id === id);
  assert.ok(model && model.type === 'chat', `${id} should be a chat model`);
  return model;
}

test('a base model resolves to the variant for the requested thinking level', () => {
  const uid = (id: string, level?: Parameters<typeof resolveDevinTarget>[1]) =>
    resolveDevinTarget(id, level).modelUid;
  assert.equal(uid('claude-opus-5-5', 'high'), 'claude-opus-5-5-high');
  assert.equal(uid('claude-opus-5-5-fast', 'max'), 'claude-opus-5-5-max-fast');
  assert.equal(uid('claude-opus-5-5'), 'claude-opus-5-5-medium');
  assert.equal(uid('claude-opus-5-5', 'off'), 'claude-opus-5-5-medium');
  assert.equal(uid('claude-opus-5-5', 'minimal'), 'claude-opus-5-5-low');
  // Neon has no `max`: clamp to its strongest effort.
  assert.equal(uid('gemini-4-neon', 'max'), 'gemini-4-neon-xhigh');
});

test('explicit variants and unknown ids pass through unchanged', () => {
  assert.deepEqual(resolveDevinTarget('gemini-4-neon-high', 'low'), {
    modelUid: 'gemini-4-neon-high',
    providerThinkingLevel: 'high',
  });
  assert.deepEqual(resolveDevinTarget('swe-1-7', 'low'), {
    modelUid: 'swe-1-7',
    providerThinkingLevel: undefined,
  });
});

test('fallback models cover every family and variant exactly once', () => {
  const ids = FALLBACK_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 5 + 4 + 4 * 5);
  assert.ok(ids.includes('claude-fable-5-2-xhigh-fast'));
});

test('live models reflect what the account has enabled, with live limits and pricing', () => {
  const models = buildLiveModels(
    catalog(
      entry('claude-opus-5-5-medium', {
        contextWindow: 500_000,
        maxTokens: 64_000,
        pricing: { input: 1, output: 2, cachedInput: 0.5 },
      }),
      entry('claude-opus-5-5-high'),
      entry('claude-opus-5-5-max', { disabled: true }),
      entry('gemini-4-neon-low', { contextWindow: 1_048_576, maxTokens: 1_000_000 }),
      entry('swe-1-7'),
    ),
  );
  assert.deepEqual(
    models.map((m) => m.id),
    [
      'gemini-4-neon',
      'claude-opus-5-5',
      'claude-opus-5-5-medium',
      'claude-opus-5-5-high',
      'gemini-4-neon-low',
    ],
  );

  const opus = chatModel(models, 'claude-opus-5-5');
  assert.equal(opus.contextWindow, 500_000);
  assert.equal(opus.maxTokens, 64_000);
  assert.deepEqual(opus.cost, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 5 });
  assert.deepEqual(opus.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  });

  // An implausible output limit (Cognition reports the context window) is ignored.
  assert.equal(chatModel(models, 'gemini-4-neon').maxTokens, 65_536);
});

test('a catalog with none of our families falls back to the static list', () => {
  assert.equal(buildLiveModels(catalog(entry('swe-1-7'))), FALLBACK_MODELS);
});
