/**
 * Per-account quota and plan lookup via
 * `exa.seat_management_pb.SeatManagementService/GetUserStatus`.
 *
 * Connect-RPC accepts plain JSON for unary calls, so we request JSON directly
 * instead of hand-decoding the ~175 KB protobuf (most of which is the model
 * catalog already fetched by `GetCascadeModelConfigs`).
 */

import { accountKey, normalizeHost, timeoutSignal, type FetchFn } from './utils.js';

const QUOTA_TTL_MS = 60_000;
const QUOTA_FETCH_TIMEOUT_MS = 10_000;

export interface DevinQuota {
  planName?: string;
  teamsTier?: string;
  billingStrategy?: string;
  /** Remaining daily quota percentage (0-100), when present. */
  dailyRemainingPercent?: number;
  /** Remaining weekly quota percentage (0-100), when present. */
  weeklyRemainingPercent?: number;
  /** Unix epoch seconds when the daily quota resets. */
  dailyResetAtUnix?: number;
  /** Unix epoch seconds when the weekly quota resets. */
  weeklyResetAtUnix?: number;
  hideDailyQuota?: boolean;
  hideWeeklyQuota?: boolean;
  /** Remaining overage / flex balance in USD (from `overageBalanceMicros`). */
  overageBalanceUsd?: number;
  /** Prompt credits used/available for credit-based plans (-1 = unlimited). */
  usedPromptCredits?: number;
  availablePromptCredits?: number;
  fetchedAt: number;
}

const cache = new Map<string, DevinQuota>();
const inflight = new Map<string, Promise<DevinQuota>>();

function numField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function boolField(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = obj?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

function objField(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const v = obj?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Parse the JSON response from `SeatManagementService/GetUserStatus`. */
export function parseUserStatusResponse(raw: unknown, fetchedAt = Date.now()): DevinQuota {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const userStatus = objField(root, 'userStatus');
  const planStatus = objField(userStatus, 'planStatus');
  const planInfo = objField(planStatus, 'planInfo') ?? objField(root, 'planInfo');

  const overageMicros = numField(planStatus, 'overageBalanceMicros');
  return {
    planName: strField(planInfo, 'planName'),
    teamsTier: strField(userStatus, 'teamsTier') ?? strField(planInfo, 'teamsTier'),
    billingStrategy: strField(planInfo, 'billingStrategy'),
    dailyRemainingPercent: numField(planStatus, 'dailyQuotaRemainingPercent'),
    weeklyRemainingPercent: numField(planStatus, 'weeklyQuotaRemainingPercent'),
    dailyResetAtUnix: numField(planStatus, 'dailyQuotaResetAtUnix'),
    weeklyResetAtUnix: numField(planStatus, 'weeklyQuotaResetAtUnix'),
    hideDailyQuota: boolField(planInfo, 'hideDailyQuota'),
    hideWeeklyQuota: boolField(planInfo, 'hideWeeklyQuota'),
    overageBalanceUsd: overageMicros !== undefined ? overageMicros / 1_000_000 : undefined,
    usedPromptCredits: numField(planStatus, 'usedPromptCredits'),
    availablePromptCredits: numField(planStatus, 'availablePromptCredits'),
    fetchedAt,
  };
}

async function fetchQuota(
  apiKey: string,
  host: string,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn,
): Promise<DevinQuota> {
  const resp = await fetchFn(
    `${host}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: JSON.stringify({
        metadata: {
          api_key: apiKey,
          ide_name: 'windsurf',
          extension_name: 'windsurf',
          extension_version: '1.9577.27',
          ide_version: '1.9577.27',
        },
      }),
      signal: timeoutSignal(QUOTA_FETCH_TIMEOUT_MS, signal),
    },
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`GetUserStatus HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return parseUserStatusResponse(JSON.parse(text));
}

/** Fetch the account's quota/plan status, cached for 60 s per account. */
export async function getCachedQuota(
  apiKey: string,
  apiServerUrl?: string,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
): Promise<DevinQuota> {
  const host = normalizeHost(apiServerUrl);
  const key = accountKey(apiKey, host);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < QUOTA_TTL_MS) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchQuota(apiKey, host, signal, fetchFn)
      .then((quota) => {
        cache.set(key, quota);
        return quota;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
  }
  return pending;
}

export function clearCachedQuota(apiKey?: string, apiServerUrl?: string): void {
  if (!apiKey) cache.clear();
  else cache.delete(accountKey(apiKey, normalizeHost(apiServerUrl)));
}
