/**
 * Shared runtime utilities for the Devin/Cognition cloud-direct client.
 */

export const DEFAULT_HOST = 'https://server.codeium.com';

const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i;

/** Pull the `(trace ID: …)` suffix Cognition appends to error messages. */
export function extractTraceId(message: string): string | undefined {
  return TRACE_ID_RE.exec(message)?.[1];
}

/** Normalize a base URL by stripping any trailing slashes. */
export function normalizeHost(host?: string): string {
  return (host || DEFAULT_HOST).replace(/\/+$/, '');
}

/** Cache key for per-account state. `host` must already be normalized. */
export function accountKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`;
}

/** A timeout signal, combined with the caller's signal when one is given. */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Decode the payload of a JWT WITHOUT verifying its signature. Only use the
 * result for display and cache scheduling (`exp`, tier), never for trust.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Headers for unary proto-over-Connect calls. */
export const UNARY_PROTO_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/proto',
  'Connect-Protocol-Version': '1',
};

export type FetchFn = typeof globalThis.fetch;
