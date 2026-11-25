import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import { mapContextToChat } from '../src/context-map.js';

const user = (content: string): Message => ({ role: 'user', content, timestamp: 0 });

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): Message {
  return {
    role: 'assistant',
    content,
    api: 'devin-cloud',
    provider: 'devin',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

const call = (id: string, name = 'read') => ({ type: 'toolCall' as const, id, name, arguments: { a: 1 } });

const result = (toolCallId: string, text: string): Message => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 0,
});

const map = (messages: Message[], systemPrompt?: string) =>
  mapContextToChat({ systemPrompt, messages } as Context).messages;

test('maps a plain exchange, dropping thinking blocks', () => {
  const messages = map(
    [
      user('hi'),
      assistant([
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: 'hello' },
      ]),
    ],
    'be nice',
  );
  assert.deepEqual(messages, [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('tool calls keep their results, and unanswered calls get a synthetic one', () => {
  const messages = map([
    user('go'),
    assistant([call('a'), call('b')], 'toolUse'),
    result('a', 'A done'),
    user('never mind'),
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', name: 'read', arguments: '{"a":1}' },
        { id: 'b', name: 'read', arguments: '{"a":1}' },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'A done' }] },
    { role: 'tool', tool_call_id: 'b', content: 'No result provided (tool execution interrupted).' },
    { role: 'user', content: 'never mind' },
  ]);
});

test('a trailing unanswered call is closed too', () => {
  const messages = map([user('go'), assistant([call('a')], 'toolUse')]);
  assert.equal(messages.at(-1)?.role, 'tool');
  assert.equal(messages.at(-1)?.tool_call_id, 'a');
});

test('unsafe tool call ids are rewritten consistently; safe ones are untouched', () => {
  const longId = `call_abc|fc_${'x'.repeat(400)}`;
  const messages = map([
    user('go'),
    assistant([call(longId), call('toolu_01-ok')], 'toolUse'),
    result(longId, 'r1'),
    result('toolu_01-ok', 'r2'),
  ]);
  const [first, second] = messages[1].tool_calls!;
  assert.match(first.id, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(second.id, 'toolu_01-ok');
  assert.equal(messages[2].tool_call_id, first.id);
  assert.equal(messages[3].tool_call_id, 'toolu_01-ok');
  assert.equal(messages.length, 4);
});

test('empty assistant messages from aborted turns are dropped', () => {
  const messages = map([user('one'), assistant([], 'aborted'), user('two')]);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'user'],
  );
});

test('images are carried through with their mime type', () => {
  const messages = map([
    {
      role: 'user',
      timestamp: 0,
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
    },
  ]);
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'image', mimeType: 'image/png', base64Data: 'QUJD' },
  ]);
});
