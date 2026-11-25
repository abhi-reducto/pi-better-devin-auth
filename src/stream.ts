/**
 * Pi `streamSimple` implementation for the Devin/Cognition provider: maps the
 * transcript, calls the cloud-direct chat stream, retries transient failures
 * that happen before any output, and reports the result as Pi stream events.
 */

import * as crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  clearCachedUserJwt,
  CloudAuthError,
  CloudChatError,
  streamChatEvents,
  type ChatHistoryItem,
  type CloudChatRequest,
} from './cloud-direct/index.js';
import { mapContextToChat } from './context-map.js';
import { AssistantMessageBuilder } from './message-builder.js';
import { resolveDevinTarget } from './models.js';

/** What `options.onPayload` sees and may replace: the request minus credentials and transport. */
type DevinRequestPayload = Required<
  Pick<CloudChatRequest, 'modelUid' | 'messages' | 'cascadeId' | 'sessionId' | 'completionOpts'>
> &
  Pick<CloudChatRequest, 'tools'>;

const DEFAULT_MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

const RETRYABLE_CONNECT_CODES = new Set([
  'unavailable',
  'deadline_exceeded',
  'resource_exhausted',
  'internal',
  'aborted',
  'unknown',
  'truncated_stream',
]);

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

/** A rejected `user_jwt`: the cached one is stale (clock skew, server-side revocation). */
function isAuthRejection(error: unknown): boolean {
  return error instanceof CloudChatError && (error.status === 401 || error.code === 'unauthenticated');
}

function isRetryable(error: unknown): boolean {
  if (isAuthRejection(error)) return true;
  if (error instanceof CloudChatError) {
    return error.status !== undefined
      ? isRetryableStatus(error.status)
      : error.code !== undefined && RETRYABLE_CONNECT_CODES.has(error.code);
  }
  if (error instanceof CloudAuthError) {
    return error.status !== undefined && isRetryableStatus(error.status);
  }
  // fetch reports network failures as TypeError("fetch failed") and an
  // elapsed AbortSignal.timeout as a TimeoutError.
  return error instanceof Error && (error.name === 'TimeoutError' || error.message === 'fetch failed');
}

function retryDelayMs(error: unknown, attempt: number, maxDelayMs: number): number {
  const backoff = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jittered = backoff * (0.75 + Math.random() * 0.25);
  const requested = error instanceof CloudChatError ? (error.retryAfterMs ?? 0) : 0;
  return Math.min(Math.max(jittered, requested), maxDelayMs);
}

/**
 * Cognition keys its prompt cache on the conversation's session and cascade
 * ids, so they must be stable across turns and across process restarts.
 * Derive them from Pi's session id, or failing that from the first user
 * message, which is the same on every turn of a conversation.
 */
function conversationIds(
  sessionId: string | undefined,
  messages: ChatHistoryItem[],
): { sessionId: string; cascadeId: string } {
  const firstUser = messages.find((m) => m.role === 'user');
  const seed = sessionId ?? JSON.stringify(firstUser?.content ?? '').slice(0, 4096);
  const uuid = (namespace: string): string => {
    const bytes = crypto.createHash('sha256').update(`${namespace}\0${seed}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  };
  return { sessionId: uuid('pi-devin-session'), cascadeId: uuid('pi-devin-cascade') };
}

/**
 * Pi triggers auto-compaction by matching known overflow phrasings. Rephrase
 * the overflow errors it would not recognize into one it does.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /context[_ -]?length|too many tokens|maximum context|token limit/i.test(message)
    ? `Context window exceeded: ${message}`
    : message;
}

export function streamDevin(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const target = resolveDevinTarget(model.id, options.reasoning);
  const builder = new AssistantMessageBuilder(stream, model, target);

  const run = async (): Promise<void> => {
    const apiKey = options.apiKey;
    if (!apiKey) throw new Error('Not signed in to Devin. Run /login devin');

    const { messages, tools } = mapContextToChat(context);
    let payload: DevinRequestPayload = {
      modelUid: target.modelUid,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...conversationIds(options.sessionId, messages),
      completionOpts: {
        maxOutputTokens: options.maxTokens ?? model.maxTokens,
        maxInputTokens: model.contextWindow,
        temperature: options.temperature,
      },
    };
    const replaced = await options.onPayload?.(payload, model);
    if (replaced && typeof replaced === 'object') payload = replaced as DevinRequestPayload;

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

    for (let attempt = 0; ; attempt++) {
      let receivedOutput = false;
      try {
        const events = streamChatEvents({
          ...payload,
          apiKey,
          apiServerUrl: model.baseUrl,
          fetch: options.fetch,
          headers: options.headers,
          onResponse: (response) => options.onResponse?.(response, model),
          signal: options.signal,
        });
        for await (const ev of events) {
          receivedOutput = true;
          await options.onProviderStreamEvent?.(ev, model);
          builder.apply(ev);
        }
        return;
      } catch (error) {
        // Once output has streamed, a retry would duplicate it.
        const canRetry =
          !receivedOutput && !options.signal?.aborted && attempt < maxRetries && isRetryable(error);
        if (!canRetry) throw error;
        if (isAuthRejection(error)) clearCachedUserJwt();
        await sleep(retryDelayMs(error, attempt, maxRetryDelayMs), undefined, { signal: options.signal });
      }
    }
  };

  run().then(
    () => builder.finish(),
    (error) => builder.fail(describeError(error), options.signal?.aborted ?? false),
  );
  return stream;
}
