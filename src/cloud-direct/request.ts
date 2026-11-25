/**
 * `GetChatMessage` request encoder.
 *
 * Field numbers come from captures of the Windsurf language server's
 * upstream traffic and the proto schema bundled in its extension.js.
 */

import * as crypto from 'node:crypto';
import { buildMetadata } from './metadata.js';
import { encodeDoubleField, encodeMessage, encodeString, encodeVarintField } from './wire.js';
import type { ChatHistoryItem, CompletionOptions, ContentPart, ToolCallRef, ToolDef } from './types.js';

/** `ChatMessageSource` enum. SYSTEM (3) is never sent — see {@link collapseSystemIntoUser}. */
const SOURCE_BY_ROLE = { user: 1, assistant: 2, tool: 4 } as const;

/** `CHAT_MESSAGE_REQUEST_TYPE_CASCADE`, matching the language server. */
const REQUEST_TYPE_CASCADE = 5;

/**
 * The tool validator rejects any description of 7,000+ chars with a
 * misleading `failed_precondition: "Unable to process request due to an MCP
 * configuration issue."`. Only per-description length is gated, not the total.
 */
const MAX_TOOL_DESC_LEN = 6998;
const TRUNCATION_NOTE = '\n…(truncated for cloud)';

type TextPart = Extract<ContentPart, { type: 'text' }>;
type ImagePart = Extract<ContentPart, { type: 'image' }>;

function toParts(content: string | ContentPart[]): ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

const wrapSystem = (texts: string[]): string => `<system>\n${texts.join('\n\n')}\n</system>`;

/**
 * Inline every `role: 'system'` message into the user message that follows it.
 * The backend answers a raw SYSTEM source with "third-party model provider is
 * experiencing issues"; the IDE itself inlines system context into the user turn.
 *
 *   [system S1, system S2, user U1, assistant A1]
 *     -> [user "<system>\nS1\n\nS2\n</system>\nU1", assistant A1]
 *
 * Trailing system messages with no following user message become their own
 * user message.
 */
export function collapseSystemIntoUser(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = [];
  let pending: string[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(toParts(m.content));
      if (text) pending.push(text);
    } else if (m.role === 'user' && pending.length > 0) {
      const parts = toParts(m.content);
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: `${wrapSystem(pending)}\n${textOf(parts)}` },
          ...parts.filter((p) => p.type === 'image'),
        ],
      });
      pending = [];
    } else {
      out.push(m);
    }
  }
  if (pending.length > 0) out.push({ role: 'user', content: wrapSystem(pending) });
  return out;
}

/** `ImageData { #1 base64_data, #2 mime_type, #3 caption }` */
function encodeImageData(img: ImagePart): Buffer {
  const parts = [encodeString(1, img.base64Data), encodeString(2, img.mimeType)];
  if (img.caption) parts.push(encodeString(3, img.caption));
  return Buffer.concat(parts);
}

/** `ChatToolCall { #1 id, #2 name, #3 arguments_json }` */
function encodeChatToolCall(tc: ToolCallRef): Buffer {
  return Buffer.concat([encodeString(1, tc.id), encodeString(2, tc.name), encodeString(3, tc.arguments)]);
}

/**
 * `ChatMessagePrompt {
 *    #2 source, #3 prompt, #4 num_tokens (rough estimate),
 *    #5 safe_for_code_telemetry, #6 tool_calls (repeated ChatToolCall),
 *    #7 tool_call_id, #10 images (repeated ImageData) }`
 *
 * Tool ids must round-trip: the backend rejects multi-tool conversations in
 * which it cannot pair a tool result with the call that produced it.
 */
function encodeChatMessagePrompt(m: ChatHistoryItem): Buffer {
  const content = toParts(m.content);
  const text = textOf(content);
  const parts: Buffer[] = [
    encodeVarintField(2, m.role === 'system' ? SOURCE_BY_ROLE.user : SOURCE_BY_ROLE[m.role]),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1),
  ];
  if (m.role === 'tool' && m.tool_call_id) parts.push(encodeString(7, m.tool_call_id));
  if (m.role === 'assistant') {
    for (const tc of m.tool_calls ?? []) parts.push(encodeMessage(6, encodeChatToolCall(tc)));
  }
  for (const p of content) {
    if (p.type === 'image') parts.push(encodeMessage(10, encodeImageData(p)));
  }
  return Buffer.concat(parts);
}

/** Sampling defaults mirror the ones the language server ships. */
function encodeCompletionConfiguration(opts: CompletionOptions): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, opts.maxInputTokens ?? 64_000),
    // The cloud clamps this to the per-model limit.
    encodeVarintField(3, opts.maxOutputTokens ?? 128_000),
    encodeDoubleField(5, opts.temperature ?? 0.7),
    encodeDoubleField(6, opts.topP ?? 0.95),
    encodeVarintField(7, opts.topK ?? 50),
    encodeDoubleField(8, 1.0),
    encodeDoubleField(11, 1.0),
  ]);
}

/** `ChatToolDefinition { #1 name, #2 description, #3 parameters_schema (JSON string) }` */
function encodeToolDef(tool: ToolDef): Buffer {
  const raw = tool.description ?? '';
  const description =
    raw.length > MAX_TOOL_DESC_LEN
      ? raw.slice(0, MAX_TOOL_DESC_LEN - TRUNCATION_NOTE.length) + TRUNCATION_NOTE
      : raw;
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(tool.parameters ?? {})),
  ]);
}

export interface ChatRequestInput {
  apiKey: string;
  userJwt: string;
  modelUid: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  cascadeId: string;
  sessionId: string;
  completionOpts?: CompletionOptions;
}

/**
 * `GetChatMessageRequest {
 *    #1 metadata, #3 chat_message_prompts (repeated), #7 request_type,
 *    #8 completion_configuration, #10 tools (repeated),
 *    #16 cascade_id, #21 chat_model_uid, #22 prompt_id }`
 */
export function buildChatRequest(input: ChatRequestInput): Buffer {
  return Buffer.concat([
    encodeMessage(1, buildMetadata(input)),
    ...collapseSystemIntoUser(input.messages).map((m) => encodeMessage(3, encodeChatMessagePrompt(m))),
    encodeVarintField(7, REQUEST_TYPE_CASCADE),
    encodeMessage(8, encodeCompletionConfiguration(input.completionOpts ?? {})),
    ...(input.tools ?? []).map((t) => encodeMessage(10, encodeToolDef(t))),
    encodeString(16, input.cascadeId),
    encodeString(21, input.modelUid),
    encodeString(22, crypto.randomUUID()),
  ]);
}
