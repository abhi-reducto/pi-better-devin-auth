/**
 * Maps Pi's transcript (`Context`) to the cloud-direct chat shapes.
 *
 * Two properties matter beyond a faithful translation:
 *
 *   - Prompt-cache stability. The leading system prompt stays the first
 *     message, and later system messages (skill loads, tool-set changes) are
 *     rendered in place as `<system-update>` user messages, so earlier turns
 *     encode to identical bytes on every request.
 *   - A well-formed tool exchange. Every assistant tool call is followed by a
 *     result, which means synthesizing one for calls an interrupted turn left
 *     unanswered, and tool call ids are normalized to a form every backend
 *     behind Cognition accepts.
 */

import {
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  renderSystemMessageUpdate,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type TextContent,
} from '@earendil-works/pi-ai';
import type { ChatHistoryItem, ContentPart, ToolCallRef, ToolDef } from './cloud-direct/index.js';

export interface MappedChat {
  messages: ChatHistoryItem[];
  tools: ToolDef[];
}

const INTERRUPTED_TOOL_RESULT = 'No result provided (tool execution interrupted).';

const systemUpdate = (text: string): ChatHistoryItem => ({
  role: 'user',
  content: `<system-update>\n${text}\n</system-update>`,
});

/**
 * Rewrites tool call ids that some backend would reject (OpenAI Responses
 * ids are ~450 chars with `|`), mapping each distinct id to one stable
 * replacement. Ids that are already safe pass through unchanged, which keeps
 * the prompt cache intact.
 */
class ToolCallIds {
  readonly #replacements = new Map<string, string>();

  normalize(id: string): string {
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
    let replacement = this.#replacements.get(id);
    if (!replacement) {
      const stem = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'call';
      replacement = `${stem}_${this.#replacements.size + 1}`;
      this.#replacements.set(id, replacement);
    }
    return replacement;
  }
}

function mapContent(content: string | (TextContent | ImageContent)[]): string | ContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', mimeType: part.mimeType, base64Data: part.data },
  );
}

/** An interrupted turn can leave an assistant message with nothing in it; it carries no information. */
function isEmptyFailure(msg: AssistantMessage): boolean {
  return (msg.stopReason === 'aborted' || msg.stopReason === 'error') && msg.content.length === 0;
}

/** Thinking blocks are dropped: Cognition's wire format has no way to replay them. */
function mapAssistant(msg: AssistantMessage, ids: ToolCallIds): ChatHistoryItem {
  const text: string[] = [];
  const toolCalls: ToolCallRef[] = [];
  for (const part of msg.content) {
    if (part.type === 'text') text.push(part.text);
    else if (part.type === 'toolCall') {
      toolCalls.push({
        id: ids.normalize(part.id),
        name: part.name,
        arguments: JSON.stringify(part.arguments ?? {}),
      });
    }
  }
  return {
    role: 'assistant',
    content: text.join('\n'),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function mapContextToChat(context: Context): MappedChat {
  const source = context.messages ?? [];
  const messages: ChatHistoryItem[] = [];
  const ids = new ToolCallIds();

  const leadingSystem = getInitialSystemMessage(source);
  const hasSystemMessages = source.some((msg) => msg.role === 'system');
  const systemPrompt = leadingSystem
    ? getSystemMessageText(leadingSystem)
    : hasSystemMessages
      ? undefined
      : context.systemPrompt;
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  // The open tool exchange: calls the last assistant message made that have no
  // result yet, and system updates that must wait until the exchange closes
  // so they don't split a call from its result.
  const unanswered = new Set<string>();
  const heldUpdates: string[] = [];

  const closeToolExchange = (): void => {
    for (const id of unanswered) {
      messages.push({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_RESULT });
    }
    unanswered.clear();
    if (heldUpdates.length > 0) messages.push(systemUpdate(heldUpdates.join('\n\n')));
    heldUpdates.length = 0;
  };

  for (const msg of source) {
    switch (msg.role) {
      case 'system': {
        if (msg === leadingSystem) break;
        const text = renderSystemMessageUpdate(msg);
        if (!text) break;
        if (unanswered.size > 0) heldUpdates.push(text);
        else messages.push(systemUpdate(text));
        break;
      }
      case 'toolResult': {
        const id = ids.normalize(msg.toolCallId);
        unanswered.delete(id);
        messages.push({ role: 'tool', tool_call_id: id, content: mapContent(msg.content) });
        break;
      }
      case 'user':
        closeToolExchange();
        messages.push({ role: 'user', content: mapContent(msg.content) });
        break;
      case 'assistant': {
        closeToolExchange();
        if (isEmptyFailure(msg)) break;
        const mapped = mapAssistant(msg, ids);
        messages.push(mapped);
        for (const call of mapped.tool_calls ?? []) unanswered.add(call.id);
        break;
      }
    }
  }
  closeToolExchange();

  const tools = hasSystemMessages ? getCurrentTools(source) : (context.tools ?? []);
  return {
    messages,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}
