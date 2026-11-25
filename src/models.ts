/**
 * Model list for the Devin (Cognition) provider.
 *
 * Each model family is registered twice:
 *   1. As a base model (`claude-opus-5-5`) whose thinking level Pi controls;
 *      {@link resolveDevinTarget} turns model + level into the Cognition
 *      variant UID (`claude-opus-5-5-high`).
 *   2. As explicit variants (`claude-opus-5-5-high`) pinned to one effort,
 *      so sessions and settings that name a variant keep working.
 *
 * Context window, output limit and pricing come live from the account's
 * catalog; the static numbers below cover startup and offline use.
 */

import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { ModelCatalog, ModelCatalogEntry } from './cloud-direct/index.js';

/** Cognition effort levels, weakest first. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

const DEFAULT_EFFORT: Effort = 'medium';

interface ModelMeta {
  contextWindow: number;
  maxTokens: number;
  /** USD per million tokens. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface Family extends ModelMeta {
  /** Base model id registered in Pi. */
  id: string;
  label: string;
  /** Cognition UIDs are `<uidPrefix>-<effort>` plus `-fast` for fast families. */
  uidPrefix: string;
  fast: boolean;
  efforts: readonly Effort[];
}

const FAMILIES: readonly Family[] = [
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    uidPrefix: 'gemini-4-neon',
    fast: false,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    uidPrefix: 'claude-opus-5-5',
    fast: false,
    efforts: EFFORTS,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  {
    id: 'claude-opus-5-5-fast',
    label: 'Claude Opus 5.5 Fast',
    uidPrefix: 'claude-opus-5-5',
    fast: true,
    efforts: EFFORTS,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
  },
  {
    id: 'claude-fable-5-2',
    label: 'Claude Fable 5.2',
    uidPrefix: 'claude-fable-5-2',
    fast: false,
    efforts: EFFORTS,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  },
  {
    id: 'claude-fable-5-2-fast',
    label: 'Claude Fable 5.2 Fast',
    uidPrefix: 'claude-fable-5-2',
    fast: true,
    efforts: EFFORTS,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 16, output: 80, cacheRead: 0.4, cacheWrite: 20 },
  },
];

const IMAGE_LIMITS = {
  images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
} as const;

const variantUid = (family: Family, effort: Effort): string =>
  `${family.uidPrefix}-${effort}${family.fast ? '-fast' : ''}`;

/** Every known variant UID -> its family and pinned effort. */
const VARIANTS = new Map<string, { family: Family; effort: Effort }>(
  FAMILIES.flatMap((family) =>
    family.efforts.map((effort) => [variantUid(family, effort), { family, effort }] as const),
  ),
);

const FAMILY_BY_ID = new Map(FAMILIES.map((family) => [family.id, family]));

/**
 * The family a catalog UID belongs to, including variants this file does not
 * know yet (a new effort level, say), or undefined for unrelated models.
 */
function familyOf(uid: string): Family | undefined {
  const known = VARIANTS.get(uid)?.family ?? FAMILY_BY_ID.get(uid);
  if (known) return known;
  const fast = uid.endsWith('-fast');
  return FAMILIES.find(
    (f) => f.fast === fast && (uid.startsWith(`${f.uidPrefix}-`) || uid.startsWith(`${f.uidPrefix}_`)),
  );
}

/** The strongest effort the family supports that does not exceed the requested level. */
function pickEffort(family: Family, level: ModelThinkingLevel | undefined): Effort {
  if (!level || level === 'off') return DEFAULT_EFFORT;
  const ceiling = EFFORTS.indexOf(level as Effort); // -1 for levels below `low`
  return family.efforts.findLast((e) => EFFORTS.indexOf(e) <= ceiling) ?? family.efforts[0];
}

/**
 * Resolve a Pi model id plus requested thinking level to the Cognition
 * `model_uid` to call and the effort that UID runs at.
 */
export function resolveDevinTarget(
  modelId: string,
  level?: ModelThinkingLevel,
): { modelUid: string; providerThinkingLevel?: string } {
  const family = FAMILY_BY_ID.get(modelId);
  if (family) {
    const effort = pickEffort(family, level);
    return { modelUid: variantUid(family, effort), providerThinkingLevel: effort };
  }
  return { modelUid: modelId, providerThinkingLevel: VARIANTS.get(modelId)?.effort };
}

function thinkingLevelMap(efforts: readonly Effort[]): ThinkingLevelMap {
  const supported = (effort: Effort): Effort | null => (efforts.includes(effort) ? effort : null);
  return {
    off: null,
    minimal: null,
    low: supported('low'),
    medium: supported('medium'),
    high: supported('high'),
    xhigh: supported('xhigh'),
    max: supported('max'),
  };
}

/** Overlay the live catalog's limits and pricing on a family's static numbers. */
function resolveMeta(family: ModelMeta, live?: ModelCatalogEntry): ModelMeta {
  if (!live) return family;
  const contextWindow = live.contextWindow ?? family.contextWindow;
  // Cognition reports a 1,000,000-token output limit for Gemini models, which
  // is really their context window. Distrust anything above half the window.
  const maxTokens = live.maxTokens && live.maxTokens <= contextWindow / 2 ? live.maxTokens : family.maxTokens;
  return {
    contextWindow,
    maxTokens,
    cost: {
      input: live.pricing?.input ?? family.cost.input,
      output: live.pricing?.output ?? family.cost.output,
      cacheRead: live.pricing?.cachedInput ?? family.cost.cacheRead,
      cacheWrite: family.cost.cacheWrite, // not in the catalog
    },
  };
}

function makeModel(
  id: string,
  name: string,
  meta: ModelMeta,
  efforts: readonly Effort[] | undefined,
): ProviderModelConfig {
  return {
    type: 'chat',
    id,
    name,
    reasoning: true,
    ...(efforts ? { thinkingLevelMap: thinkingLevelMap(efforts) } : {}),
    input: ['text', 'image'],
    inputLimits: IMAGE_LIMITS,
    cost: meta.cost,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
  };
}

const capitalize = (s: string): string => (s === 'xhigh' ? 'XHigh' : s[0].toUpperCase() + s.slice(1));

function staticVariantLabel(family: Family, effort: Effort): string {
  const base = family.label.replace(/ Fast$/, '');
  return `${base} ${capitalize(effort)}${family.fast ? ' Fast' : ''}`;
}

/** Models shown before sign-in or when the catalog cannot be fetched. */
export const FALLBACK_MODELS: ProviderModelConfig[] = [
  ...FAMILIES.map((family) => makeModel(family.id, family.label, family, family.efforts)),
  ...[...VARIANTS].map(([uid, { family, effort }]) =>
    makeModel(uid, staticVariantLabel(family, effort), family, [effort]),
  ),
];

/**
 * Models for an account: every family with at least one enabled effort, then
 * every enabled catalog variant of those families, with live limits and pricing.
 */
export function buildLiveModels(catalog: ModelCatalog): ProviderModelConfig[] {
  const enabled = (uid: string): ModelCatalogEntry | undefined => {
    const entry = catalog.byUid.get(uid);
    return entry && !entry.disabled ? entry : undefined;
  };

  const models: ProviderModelConfig[] = [];
  for (const family of FAMILIES) {
    const efforts = family.efforts.filter((effort) => enabled(variantUid(family, effort)));
    if (efforts.length === 0) continue;
    const sample = efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : efforts[0];
    const meta = resolveMeta(family, enabled(variantUid(family, sample)));
    models.push(makeModel(family.id, family.label, meta, efforts));
  }

  for (const entry of catalog.byUid.values()) {
    const family = familyOf(entry.modelUid);
    if (!family || entry.disabled || FAMILY_BY_ID.has(entry.modelUid)) continue;
    const pinned = VARIANTS.get(entry.modelUid)?.effort;
    models.push(
      makeModel(entry.modelUid, entry.label, resolveMeta(family, entry), pinned ? [pinned] : undefined),
    );
  }

  return models.length > 0 ? models : FALLBACK_MODELS;
}
