/**
 * Per-account model catalog lookup via `GetCascadeModelConfigs`.
 *
 * Parses `exa.codeium_common_pb.ClientModelConfig`:
 *   #1  label                string
 *   #4  disabled             bool
 *   #18 max_context_tokens   uint64
 *   #22 model_uid            string
 *   #23 model_info           { #13 max_output_tokens, #23 base_model_id }
 *   #32 pricing_entries      repeated { #1 label, #2 price_usd_per_m (float32) }
 */

import { getCachedUserJwt } from './auth.js';
import { buildMetadata } from './metadata.js';
import { encodeMessage, fieldBytes, fieldFloat, fieldString, fieldVarint, iterFields } from './wire.js';
import { accountKey, normalizeHost, timeoutSignal, UNARY_PROTO_HEADERS, type FetchFn } from './utils.js';

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

export interface ModelCatalogPricing {
  /** USD per million tokens. */
  input?: number;
  cachedInput?: number;
  output?: number;
}

export interface ModelCatalogEntry {
  modelUid: string;
  label: string;
  disabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
  baseModelId?: string;
  pricing?: ModelCatalogPricing;
}

export interface ModelCatalog {
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
}

export class ModelNotAvailableError extends Error {
  constructor(
    public readonly modelUid: string,
    public readonly label: string,
    public readonly reason: 'disabled' | 'not_listed',
  ) {
    super(
      reason === 'disabled'
        ? `Model "${label}" (uid=${modelUid}) is not enabled for your Cognition account. Check https://codeium.com/account or pick a different model.`
        : `Model uid "${modelUid}" is not listed in the Cognition catalog for your account. Run /devin-refresh to refresh available models.`,
    );
    this.name = 'ModelNotAvailableError';
  }
}

const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;

function parsePricingEntry(buf: Buffer): { label: string; usdPerMillion: number } | null {
  let label = '';
  let price: number | undefined;
  for (const f of iterFields(buf)) {
    label = fieldString(f, 1) ?? label;
    const v = fieldFloat(f, 2);
    // float32 on the wire: round away the representation noise (3.0000001 -> 3).
    if (v !== undefined && Number.isFinite(v) && v >= 0) price = Math.round(v * 10_000) / 10_000;
  }
  return label && price !== undefined ? { label, usdPerMillion: price } : null;
}

function parseClientModelConfig(buf: Buffer): ModelCatalogEntry | null {
  const entry: ModelCatalogEntry = { modelUid: '', label: '', disabled: false };

  for (const f of iterFields(buf)) {
    entry.label = fieldString(f, 1) ?? entry.label;
    entry.modelUid = fieldString(f, 22) ?? entry.modelUid;
    if (fieldVarint(f, 4) !== undefined) entry.disabled = fieldVarint(f, 4) === 1;
    entry.contextWindow = positive(fieldVarint(f, 18)) ?? entry.contextWindow;

    const info = fieldBytes(f, 23);
    if (info) {
      for (const sf of iterFields(info)) {
        entry.maxTokens = positive(fieldVarint(sf, 13)) ?? entry.maxTokens;
        entry.baseModelId = fieldString(sf, 23) || entry.baseModelId;
      }
    }

    const pricingBytes = fieldBytes(f, 32);
    const price = pricingBytes && parsePricingEntry(pricingBytes);
    if (price) {
      entry.pricing ??= {};
      if (price.label === 'Input') entry.pricing.input = price.usdPerMillion;
      else if (price.label === 'Cached input') entry.pricing.cachedInput = price.usdPerMillion;
      else if (price.label === 'Output') entry.pricing.output = price.usdPerMillion;
    }
  }

  if (!entry.modelUid) return null;
  entry.label ||= entry.modelUid;
  return entry;
}

async function fetchCatalog(
  apiKey: string,
  host: string,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn,
): Promise<ModelCatalog> {
  const userJwt = await getCachedUserJwt(apiKey, host, fetchFn);
  const resp = await fetchFn(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
    method: 'POST',
    headers: UNARY_PROTO_HEADERS,
    body: new Uint8Array(encodeMessage(1, buildMetadata({ apiKey, userJwt }))),
    signal: timeoutSignal(CATALOG_FETCH_TIMEOUT_MS, signal),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GetCascadeModelConfigs HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const byUid = new Map<string, ModelCatalogEntry>();
  for (const f of iterFields(Buffer.from(await resp.arrayBuffer()))) {
    const config = fieldBytes(f, 1);
    const entry = config && parseClientModelConfig(config);
    if (entry) byUid.set(entry.modelUid, entry);
  }
  return { byUid, fetchedAt: Date.now() };
}

const cache = new Map<string, ModelCatalog>();
const inFlight = new Map<string, Promise<ModelCatalog>>();
/** Bumped on clear so a fetch that started before the clear cannot repopulate the cache. */
let cacheEpoch = 0;

const isFresh = (catalog: ModelCatalog): boolean => Date.now() - catalog.fetchedAt < CATALOG_TTL_MS;

/**
 * The account's model catalog, from cache when fresh. Rejects when the fetch
 * fails; concurrent callers share one in-flight fetch.
 */
export async function getCachedCatalog(
  apiKey: string,
  host?: string,
  signal?: AbortSignal,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<ModelCatalog> {
  const baseUrl = normalizeHost(host);
  const key = accountKey(apiKey, baseUrl);
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const epochAtStart = cacheEpoch;
  const promise = fetchCatalog(apiKey, baseUrl, signal, fetchFn)
    .then((catalog) => {
      if (cacheEpoch === epochAtStart) cache.set(key, catalog);
      return catalog;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/**
 * The in-memory catalog, without waiting on the network. A missing or stale
 * catalog triggers a background refresh; a stale one is still returned.
 */
export function getCatalogSnapshot(
  apiKey: string,
  host?: string,
  fetchFn: FetchFn = globalThis.fetch,
): ModelCatalog | null {
  const baseUrl = normalizeHost(host);
  const cached = cache.get(accountKey(apiKey, baseUrl)) ?? null;
  if (!cached || !isFresh(cached)) {
    getCachedCatalog(apiKey, baseUrl, undefined, fetchFn).catch(() => {});
  }
  return cached;
}

export function clearCachedCatalog(): void {
  cache.clear();
  inFlight.clear();
  cacheEpoch++;
}
