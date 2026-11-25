/**
 * Exchange a Firebase ID token for a long-lived Windsurf API key, using the
 * same RPC the Windsurf desktop extension calls after browser sign-in:
 *
 *   POST <register host>/exa.seat_management_pb.SeatManagementService/RegisterUser
 *   { "firebase_id_token": "<jwt>" }  ->  { api_key, name, api_server_url, … }
 *
 * Connect-RPC accepts plain JSON for unary calls, so no framing is needed.
 */

import { DEFAULT_HOST, extractTraceId, normalizeHost, timeoutSignal } from '../cloud-direct/utils.js';
import type { RegisteredUser, WindsurfRegion } from './types.js';

const REGISTER_TIMEOUT_MS = 30_000;

export class WindsurfRegistrationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly connectCode?: string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = 'WindsurfRegistrationError';
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const stringField = (obj: Record<string, unknown> | null, key: string): string | undefined => {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export async function registerUser(
  firebaseIdToken: string,
  region: WindsurfRegion,
  signal?: AbortSignal,
): Promise<RegisteredUser> {
  const url = `${normalizeHost(region.registerApiServerUrl)}/exa.seat_management_pb.SeatManagementService/RegisterUser`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
    signal: timeoutSignal(REGISTER_TIMEOUT_MS, signal),
  });
  const text = await response.text();
  const body = parseJson(text);

  if (!response.ok) {
    const message =
      stringField(body, 'message') ?? (text || `RegisterUser failed with HTTP ${response.status}`);
    throw new WindsurfRegistrationError(
      message,
      response.status,
      stringField(body, 'code'),
      extractTraceId(message),
    );
  }

  const apiKey = stringField(body, 'api_key');
  const name = stringField(body, 'name');
  if (!apiKey || !name) {
    throw new WindsurfRegistrationError(
      `RegisterUser succeeded but returned no ${apiKey ? 'name' : 'api_key'}`,
      response.status,
      'malformed_response',
    );
  }
  return { apiKey, name, apiServerUrl: stringField(body, 'api_server_url') ?? DEFAULT_HOST };
}
