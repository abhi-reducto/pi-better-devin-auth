/**
 * Folds cloud-direct chat events into a Pi `AssistantMessage`, emitting Pi's
 * streaming events as the message grows.
 *
 * Cognition's stream is strictly sequential, so at most one content block
 * (text, thinking or a tool call) is open at a time: any event of another
 * kind closes the open block and starts a new one.
 */

import {
  calculateCost,
  ToolCallArgumentsStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import type { CloudChatEvent } from './cloud-direct/index.js';

type OpenBlock =
  | { kind: 'text' | 'thinking'; index: number }
  | { kind: 'toolCall'; index: number; args: ToolCallArgumentsStream };

export class AssistantMessageBuilder {
  readonly message: AssistantMessage;
  readonly #stream: AssistantMessageEventStream;
  readonly #model: Model<Api>;
  #open: OpenBlock | undefined;
  #started = false;
  #sawToolCall = false;

  constructor(
    stream: AssistantMessageEventStream,
    model: Model<Api>,
    target: { modelUid: string; providerThinkingLevel?: string },
  ) {
    this.#stream = stream;
    this.#model = model;
    this.message = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      ...(target.modelUid !== model.id ? { responseModel: target.modelUid } : {}),
      ...(target.providerThinkingLevel ? { providerThinkingLevel: target.providerThinkingLevel } : {}),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending',
      timestamp: Date.now(),
    };
  }

  apply(ev: CloudChatEvent): void {
    this.#start();
    switch (ev.kind) {
      case 'text':
        this.#appendText('text', ev.text);
        break;
      case 'reasoning':
        this.#appendText('thinking', ev.text);
        break;
      case 'tool_call_start':
        this.#startToolCall(ev.id, ev.name);
        break;
      case 'tool_call_args':
        this.#appendToolCallArgs(ev.argsDelta);
        break;
      case 'finish':
        this.message.rawStopReason = ev.reason;
        if (ev.reason === 'length') this.message.stopReason = 'length';
        break;
      case 'usage':
        this.#setUsage(ev);
        break;
    }
  }

  /** Close the message and emit `done`. */
  finish(): void {
    this.#start();
    this.#closeBlock();
    if (this.message.stopReason !== 'length') {
      // Some models report a plain stop after emitting tool calls; the calls
      // are what tell Pi to run them.
      this.message.stopReason = this.#sawToolCall ? 'toolUse' : 'stop';
    }
    this.#stream.push({ type: 'done', reason: this.message.stopReason, message: this.message });
    this.#stream.end();
  }

  /** Emit `error` with whatever content had arrived. */
  fail(errorMessage: string, aborted: boolean): void {
    this.message.stopReason = aborted ? 'aborted' : 'error';
    this.message.errorMessage = errorMessage;
    this.#stream.push({ type: 'error', reason: this.message.stopReason, error: this.message });
    this.#stream.end();
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stream.push({ type: 'start', partial: this.message });
  }

  #appendText(kind: 'text' | 'thinking', delta: string): void {
    if (this.#open?.kind !== kind) {
      this.#closeBlock();
      this.message.content.push(
        kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      );
      this.#open = { kind, index: this.message.content.length - 1 };
      this.#stream.push({ type: `${kind}_start`, contentIndex: this.#open.index, partial: this.message });
    }
    const contentIndex = this.#open.index;
    const block = this.message.content[contentIndex];
    if (block.type === 'text') block.text += delta;
    else if (block.type === 'thinking') block.thinking += delta;
    this.#stream.push({ type: `${kind}_delta`, contentIndex, delta, partial: this.message });
  }

  #startToolCall(id: string, name: string): void {
    this.#closeBlock();
    this.#sawToolCall = true;
    this.message.content.push({ type: 'toolCall', id, name, arguments: {} });
    this.#open = {
      kind: 'toolCall',
      index: this.message.content.length - 1,
      args: new ToolCallArgumentsStream(),
    };
    this.#stream.push({ type: 'toolcall_start', contentIndex: this.#open.index, partial: this.message });
  }

  #appendToolCallArgs(delta: string): void {
    if (this.#open?.kind !== 'toolCall') return; // arguments with no call to attach to
    const block = this.message.content[this.#open.index];
    if (block.type === 'toolCall') block.arguments = this.#open.args.append(delta);
    this.#stream.push({
      type: 'toolcall_delta',
      contentIndex: this.#open.index,
      delta,
      partial: this.message,
    });
  }

  #closeBlock(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    const contentIndex = open.index;
    const block = this.message.content[contentIndex];

    if (block.type === 'text') {
      this.#stream.push({ type: 'text_end', contentIndex, content: block.text, partial: this.message });
    } else if (block.type === 'thinking') {
      this.#stream.push({
        type: 'thinking_end',
        contentIndex,
        content: block.thinking,
        partial: this.message,
      });
    } else if (open.kind === 'toolCall') {
      const finished = open.args.finish();
      block.arguments = finished.arguments;
      if (finished.argumentsError) block.argumentsError = finished.argumentsError;
      this.#stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: this.message });
    }
  }

  #setUsage(ev: Extract<CloudChatEvent, { kind: 'usage' }>): void {
    const usage = this.message.usage;
    usage.input = ev.promptTokens ?? 0;
    usage.output = ev.completionTokens ?? 0;
    usage.cacheRead = ev.cachedInputTokens ?? 0;
    usage.cacheWrite = ev.cacheCreationInputTokens ?? 0;
    if (ev.reasoningTokens !== undefined) usage.reasoning = ev.reasoningTokens;
    // Cognition reports cached tokens separately from fresh input, so the
    // context size is the sum of all four.
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    calculateCost(this.#model, usage);
  }
}
