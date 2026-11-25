/**
 * Short-lived `user_jwt` minting and stale-while-revalidate cache via
 * `exa.auth_pb.AuthService/GetUserJwt`.
 *
 * The JWT lives in memory only. Concurrent callers share one in-flight mint,
 * which is why a mint is bounded by its own timeout rather than by any one
 * caller's abort signal.
 */

import { buildMetadata } from './metadata.js';
import { encodeMessage, fieldString, iterFields } from './wire.js';
import {
  accountKey,
  decodeJwtPayload,
  normalizeHost,
  timeoutSignal,
  UNARY_PROTO_HEADERS,
  type FetchFn,
} from './utils.js';

export class CloudAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudAuthError';
  }
}

interface MintedUserJwt {
  jwt: string;
  /** Unix epoch seconds when the JWT expires. */
  expiresAt: number;
}

const MINT_TIMEOUT_MS = 15_000;
/** Block and mint if less than this remains. */
const HARD_REFRESH_MARGIN_SEC = 60;
/** Serve the cached JWT but refresh in the background if less than this remains. */
const SOFT_REFRESH_MARGIN_SEC = 300;
/** Assumed lifetime when the JWT carries no usable `exp`. */
const FALLBACK_TTL_SEC = 600;
const JWT_SHAPE_RE = /^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/;

const nowSec = (): number => Math.floor(Date.now() / 1000);

async function mintUserJwt(apiKey: string, host: string, fetchFn: FetchFn): Promise<MintedUserJwt> {
  const resp = await fetchFn(`${host}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: 'POST',
    headers: UNARY_PROTO_HEADERS,
    body: new Uint8Array(encodeMessage(1, buildMetadata({ apiKey }))),
    signal: timeoutSignal(MINT_TIMEOUT_MS),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new CloudAuthError(
      `GetUserJwt HTTP ${resp.status}: ${buf.toString('utf8').slice(0, 400)}`,
      resp.status,
    );
  }

  let jwt: string | undefined;
  for (const f of iterFields(buf)) {
    const s = fieldString(f, 1);
    if (s && JWT_SHAPE_RE.test(s)) {
      jwt = s;
      break;
    }
  }
  if (!jwt) {
    throw new CloudAuthError(`GetUserJwt returned HTTP 200 without a JWT (${buf.length} bytes)`);
  }

  const exp = decodeJwtPayload(jwt)?.exp;
  const expiresAt = typeof exp === 'number' && Number.isFinite(exp) ? exp : nowSec() + FALLBACK_TTL_SEC;
  return { jwt, expiresAt };
}

const cache = new Map<string, MintedUserJwt>();
const inFlight = new Map<string, Promise<MintedUserJwt>>();
/** Bumped on clear so a mint that started before the clear cannot repopulate the cache. */
let cacheEpoch = 0;

function startMint(key: string, apiKey: string, host: string, fetchFn: FetchFn): Promise<MintedUserJwt> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const epochAtStart = cacheEpoch;
  const promise = mintUserJwt(apiKey, host, fetchFn)
    .then((minted) => {
      if (cacheEpoch === epochAtStart) cache.set(key, minted);
      return minted;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** A valid `user_jwt` for this account, minting or refreshing it as needed. */
export async function getCachedUserJwt(
  apiKey: string,
  host?: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
  const baseUrl = normalizeHost(host);
  const key = accountKey(apiKey, baseUrl);
  const cached = cache.get(key);
  const now = nowSec();

  if (cached && cached.expiresAt > now + HARD_REFRESH_MARGIN_SEC) {
    if (cached.expiresAt <= now + SOFT_REFRESH_MARGIN_SEC) {
      startMint(key, apiKey, baseUrl, fetchFn).catch(() => {});
    }
    return cached.jwt;
  }
  return (await startMint(key, apiKey, baseUrl, fetchFn)).jwt;
}

export function clearCachedUserJwt(): void {
  cache.clear();
  inFlight.clear();
  cacheEpoch++;
}
