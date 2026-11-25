/**
 * Streaming chat against `ApiServerService/GetChatMessage`, straight to the
 * Cognition cloud with no local language server in the path.
 */

import * as crypto from 'node:crypto';
import { getCachedUserJwt } from './auth.js';
import { getCatalogSnapshot, ModelNotAvailableError } from './catalog.js';
import { buildChatRequest } from './request.js';
import { decodeChatFrame, parseTrailer, type TrailerError } from './response.js';
import { CloudChatError, type CloudChatEvent, type CloudChatRequest } from './types.js';
import { normalizeHost } from './utils.js';
import { ConnectFrameDecoder, frameConnectMessage, type ConnectFrame } from './wire.js';

/** Large prompts on high reasoning effort are slow to start. */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 120_000;
/** The cloud's own idle limit is about 90s. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * Aborts a request when the server goes quiet. `arm` starts (or restarts) the
 * countdown for one wait; `disarm` stops it while we are not waiting on the
 * network, so a slow consumer is never mistaken for a stalled server.
 */
class Watchdog {
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  arm(ms: number, waitingFor: string): void {
    this.disarm();
    this.#timer = setTimeout(() => {
      this.#controller.abort(
        new CloudChatError(`Cognition sent no ${waitingFor} for ${ms / 1000}s`, 'deadline_exceeded'),
      );
    }, ms);
  }

  disarm(): void {
    clearTimeout(this.#timer);
  }
}

function assertModelAvailable(req: CloudChatRequest, host: string): void {
  // Snapshot only: a chat turn never waits on the catalog. With no catalog
  // yet, the request goes out and the trailer reports any denial.
  const catalog = getCatalogSnapshot(req.apiKey, host, req.fetch);
  if (!catalog) return;
  const model = catalog.byUid.get(req.modelUid);
  if (!model) throw new ModelNotAvailableError(req.modelUid, req.modelUid, 'not_listed');
  if (model.disabled) throw new ModelNotAvailableError(req.modelUid, model.label, 'disabled');
}

function requestHeaders(req: CloudChatRequest, compressed: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/connect+proto',
    'Connect-Protocol-Version': '1',
    'Connect-Accept-Encoding': 'gzip',
    ...(compressed ? { 'Connect-Content-Encoding': 'gzip' } : {}),
  };
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function trailerToError(trailer: TrailerError, modelUid: string): CloudChatError {
  // Cognition reports "this account can't run this model" as an opaque
  // permission_denied. Name the model and the likely cause, keeping the
  // original text for bug reports.
  const opaqueDenial =
    trailer.code === 'permission_denied' && /an internal error occurred/i.test(trailer.message);
  const message = opaqueDenial
    ? `Cognition denied the request for model "${modelUid}". This usually means the model is not ` +
      `enabled for your account or tier (https://codeium.com/account). Cloud message: ${trailer.message}`
    : trailer.message;
  return new CloudChatError(message, trailer.code, trailer.traceId);
}

/**
 * Stream one chat completion as {@link CloudChatEvent}s.
 *
 * Throws {@link CloudChatError} for transport and cloud failures and
 * {@link ModelNotAvailableError} when the catalog rules the model out. When
 * `req.signal` aborts, the signal's reason is thrown.
 */
export async function* streamChatEvents(req: CloudChatRequest): AsyncGenerator<CloudChatEvent> {
  const fetchFn = req.fetch ?? globalThis.fetch;
  const host = normalizeHost(req.apiServerUrl);

  assertModelAvailable(req, host);
  const userJwt = await getCachedUserJwt(req.apiKey, host, fetchFn);
  req.signal?.throwIfAborted();

  const { frame, compressed } = await frameConnectMessage(
    buildChatRequest({
      apiKey: req.apiKey,
      userJwt,
      modelUid: req.modelUid,
      messages: req.messages,
      tools: req.tools,
      cascadeId: req.cascadeId ?? crypto.randomUUID(),
      sessionId: req.sessionId ?? crypto.randomUUID(),
      completionOpts: req.completionOpts,
    }),
  );

  const watchdog = new Watchdog();
  const signal = req.signal ? AbortSignal.any([req.signal, watchdog.signal]) : watchdog.signal;

  try {
    watchdog.arm(req.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS, 'response');
    const resp = await fetchFn(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
      method: 'POST',
      headers: requestHeaders(req, compressed),
      body: new Uint8Array(frame),
      signal,
    });
    watchdog.disarm();

    await req.onResponse?.({ status: resp.status, headers: Object.fromEntries(resp.headers) });

    if (!resp.ok) {
      const text = await resp.text();
      throw new CloudChatError(
        `GetChatMessage HTTP ${resp.status}: ${text.slice(0, 300)}`,
        undefined,
        undefined,
        resp.status,
        parseRetryAfterMs(resp.headers.get('retry-after')),
      );
    }
    if (!resp.body) throw new CloudChatError('GetChatMessage response had no body stream');

    const reader = resp.body.getReader();
    const decoder = new ConnectFrameDecoder();
    let trailer: TrailerError | null | undefined;
    // A fetch implementation that ignores `signal` mid-body would leave the
    // read pending forever; cancelling the reader settles it.
    const cancelRead = (): void => void reader.cancel(signal.reason).catch(() => {});
    signal.addEventListener('abort', cancelRead, { once: true });

    try {
      while (trailer === undefined) {
        watchdog.arm(req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 'data');
        const { value, done } = await reader.read();
        watchdog.disarm();
        signal.throwIfAborted();
        if (done) break;

        for (const { payload, endStream } of decodeFrames(decoder, value)) {
          if (endStream) trailer = parseTrailer(payload);
          else yield* decodeChatFrame(payload);
        }
      }
    } finally {
      signal.removeEventListener('abort', cancelRead);
      await reader.cancel().catch(() => {});
    }

    if (trailer) throw trailerToError(trailer, req.modelUid);
    // A healthy stream always ends with a trailer; without one the
    // connection dropped and the response is incomplete.
    if (trailer === undefined) {
      throw new CloudChatError(
        `Cognition's stream ended without a trailer (${decoder.pendingBytes} bytes unparsed); the connection likely dropped mid-response.`,
        'truncated_stream',
      );
    }
  } finally {
    watchdog.disarm();
  }
}

function decodeFrames(decoder: ConnectFrameDecoder, chunk: Uint8Array): ConnectFrame[] {
  try {
    return decoder.push(chunk);
  } catch (err) {
    throw new CloudChatError(`Malformed Connect stream: ${(err as Error).message}`, 'data_loss');
  }
}
