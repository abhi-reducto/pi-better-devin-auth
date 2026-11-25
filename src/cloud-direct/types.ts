/**
 * Public types of the cloud-direct chat client.
 */

import type { FetchFn } from './utils.js';

export type ContentPart =
  { type: 'text'; text: string } | { type: 'image'; mimeType: string; base64Data: string; caption?: string };

export interface ToolCallRef {
  id: string;
  name: string;
  /** Arguments as a JSON string. */
  arguments: string;
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** A plain string is shorthand for one text part. */
  content: string | ContentPart[];
  /** `role: 'tool'` only: id of the assistant tool call this result answers. */
  tool_call_id?: string;
  /** `role: 'assistant'` only: the tool calls the assistant emitted. */
  tool_calls?: ToolCallRef[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the function's arguments. */
  parameters: unknown;
}

export interface CompletionOptions {
  maxOutputTokens?: number;
  maxInputTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

/**
 * Streaming event emitted by the chat loop.
 *
 * There is no `tool_call_end`: the wire format ends a tool call implicitly,
 * so each `tool_call_start` (or the end of the stream) closes the previous
 * call. Argument deltas carry no id and belong to the most recent start.
 */
export type CloudChatEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call_start'; id: string; name: string }
  | { kind: 'tool_call_args'; argsDelta: string }
  | { kind: 'finish'; reason: FinishReason }
  | {
      kind: 'usage';
      /** Fresh (uncached) input tokens. */
      promptTokens?: number;
      completionTokens?: number;
      /** Input tokens served from the prompt cache; not included in `promptTokens`. */
      cachedInputTokens?: number;
      /** Input tokens written to the prompt cache; not included in `promptTokens`. */
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
    };

export interface CloudChatRequest {
  /** Long-lived API key from RegisterUser (`devin-session-token$<JWT>`). */
  apiKey: string;
  /** API server base URL; defaults to `https://server.codeium.com`. */
  apiServerUrl?: string;
  /** Model UID, e.g. `claude-opus-5-5-medium`. */
  modelUid: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  /**
   * Conversation ids. Keep both stable across the turns of one conversation
   * so the server-side prompt cache stays warm; random ids are used when omitted.
   */
  cascadeId?: string;
  sessionId?: string;
  completionOpts?: CompletionOptions;
  /** Custom fetch implementation (instrumentation, tests). */
  fetch?: FetchFn;
  /** Extra HTTP headers for the chat request; `null` removes a default header. */
  headers?: Record<string, string | null>;
  /** Called with the HTTP response head before the body is consumed. */
  onResponse?: (response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
  signal?: AbortSignal;
  /** Longest wait for the response to start, and longest mid-stream silence. Default 120s each. */
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class CloudChatError extends Error {
  constructor(
    message: string,
    /** Connect error code (`permission_denied`, …) or a local one (`deadline_exceeded`, `truncated_stream`). */
    public readonly code?: string,
    public readonly traceId?: string,
    /** HTTP status, when the request failed before a stream was established. */
    public readonly status?: number,
    /** Server-requested retry delay in milliseconds, from `Retry-After`. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CloudChatError';
  }
}
