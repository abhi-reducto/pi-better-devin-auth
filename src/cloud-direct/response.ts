/**
 * `GetChatMessage` response decoders.
 */

import { fieldBytes, fieldFloat, fieldString, fieldVarint, iterFields } from './wire.js';
import { extractTraceId } from './utils.js';
import type { CloudChatEvent, FinishReason } from './types.js';

/**
 * `exa.codeium_common_pb.StopReason`, from the enum table in Windsurf's extension.js:
 *    0 UNSPECIFIED, 2 STOP_PATTERN, 4-9 internal, 12 NON_INSERTION, 13 ERROR -> stop
 *    1 INCOMPLETE, 3 MAX_TOKENS                                              -> length
 *   10 FUNCTION_CALL                                                         -> tool_calls
 *   11 CONTENT_FILTER                                                        -> content_filter
 * (Real errors arrive in the Connect trailer, not as stop reason 13.)
 */
function mapStopReason(v: number): FinishReason {
  if (v === 10) return 'tool_calls';
  if (v === 11) return 'content_filter';
  if (v === 1 || v === 3) return 'length';
  return 'stop';
}

/**
 * Decode one streamed `ChatMessage` frame:
 *
 *   ChatMessage {
 *     #3  delta_text       visible answer text
 *     #5  stop_reason      varint, see {@link mapStopReason}
 *     #6  ToolCallDelta    { #1 id, #2 name (both on the first frame only), #3 arguments_delta }
 *     #9  delta_thinking   chain-of-thought text
 *     #28 UsageStats
 *   }
 *
 * #3 and #9 are easy to swap; verified live that #3 carries the answer and
 * #9 the model's reasoning.
 */
export function* decodeChatFrame(proto: Buffer): Generator<CloudChatEvent> {
  for (const f of iterFields(proto)) {
    const text = fieldString(f, 3);
    if (text) yield { kind: 'text', text };

    const reasoning = fieldString(f, 9);
    if (reasoning) yield { kind: 'reasoning', text: reasoning };

    const toolCall = fieldBytes(f, 6);
    if (toolCall) yield* decodeToolCallDelta(toolCall);

    const stopReason = fieldVarint(f, 5);
    if (stopReason !== undefined) yield { kind: 'finish', reason: mapStopReason(stopReason) };

    const usageBytes = fieldBytes(f, 28);
    const usage = usageBytes && decodeUsageStats(usageBytes);
    if (usage) yield usage;
  }
}

function* decodeToolCallDelta(buf: Buffer): Generator<CloudChatEvent> {
  let id: string | undefined;
  let name: string | undefined;
  let argsDelta: string | undefined;
  for (const f of iterFields(buf)) {
    id = fieldString(f, 1) ?? id;
    name = fieldString(f, 2) ?? name;
    argsDelta = fieldString(f, 3) ?? argsDelta;
  }
  if (id !== undefined && name !== undefined) yield { kind: 'tool_call_start', id, name };
  if (argsDelta !== undefined) yield { kind: 'tool_call_args', argsDelta };
}

/**
 * `UsageStats { #1 label, #2 entries (repeated) }` where each entry is
 *
 *   UsageEntry {
 *     #4 display { #1 label, #2 value (float32), #3 unit, #4 unit_plural }
 *     #5 metric_id   "input_tokens" | "output_tokens" | "cached_input_tokens" | …
 *   }
 */
function decodeUsageStats(buf: Buffer): CloudChatEvent | null {
  const totals = new Map<string, number>();

  for (const f of iterFields(buf)) {
    const entry = fieldBytes(f, 2);
    if (!entry) continue;

    let metric: string | undefined;
    let value: number | undefined;
    for (const sf of iterFields(entry)) {
      metric = fieldString(sf, 5) ?? metric;
      const display = fieldBytes(sf, 4);
      if (!display) continue;
      for (const ssf of iterFields(display)) {
        value = fieldFloat(ssf, 2) ?? value;
      }
    }
    if (metric && value !== undefined && Number.isFinite(value)) {
      totals.set(metric, (totals.get(metric) ?? 0) + Math.round(value));
    }
  }

  const sum = (...metrics: string[]): number | undefined => {
    const present = metrics.filter((m) => totals.has(m));
    return present.length > 0 ? present.reduce((acc, m) => acc + totals.get(m)!, 0) : undefined;
  };

  const promptTokens = sum('input_tokens');
  const completionTokens = sum('output_tokens');
  if (promptTokens === undefined && completionTokens === undefined) return null;
  return {
    kind: 'usage',
    promptTokens,
    completionTokens,
    cachedInputTokens: sum('cached_input_tokens', 'cache_read_input_tokens'),
    cacheCreationInputTokens: sum('cache_creation_input_tokens'),
    reasoningTokens: sum('reasoning_tokens', 'output_reasoning_tokens'),
  };
}

export interface TrailerError {
  code?: string;
  message: string;
  traceId?: string;
}

/** Parse the end-of-stream trailer: `{}` on success, `{"error":{code,message}}` on failure. */
export function parseTrailer(payload: Buffer): TrailerError | null {
  const text = payload.toString('utf8');
  if (!text.includes('"error"')) return null;
  let code: string | undefined;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (!parsed.error) return null;
    code = parsed.error.code;
    if (parsed.error.message) message = parsed.error.message;
  } catch {
    // not JSON — report the raw trailer text
  }
  return { code, message, traceId: extractTraceId(message) };
}
