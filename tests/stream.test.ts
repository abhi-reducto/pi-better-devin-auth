import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai';
import { clearCachedCatalog, clearCachedUserJwt } from '../src/cloud-direct/index.js';
import { streamDevin } from '../src/stream.js';
import { collect, dataFrame, fakeCloud, msg, streamResponse, trailer, type FakeCloud } from './helpers.js';

const model = {
  id: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  api: 'devin-cloud',
  provider: 'devin',
  baseUrl: 'https://cloud.test',
  reasoning: true,
  input: ['text'],
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as unknown as Model<Api>;

const context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] } as Context;

async function run(cloud: FakeCloud, options: Parameters<typeof streamDevin>[2] = {}) {
  const events: AssistantMessageEvent[] = await collect(
    streamDevin(model, context, { apiKey: 'key', fetch: cloud.fetch, maxRetryDelayMs: 1, ...options }),
  );
  const last = events.at(-1)!;
  const message: AssistantMessage =
    last.type === 'done'
      ? last.message
      : last.type === 'error'
        ? last.error
        : assert.fail('no terminal event');
  return { events, message, types: events.map((e) => e.type) };
}

const ok = (...frames: Buffer[]): Response => streamResponse([...frames, trailer()]);

beforeEach(() => {
  clearCachedUserJwt();
  clearCachedCatalog();
});

test('builds a message with thinking, text and usage', async () => {
  const cloud = fakeCloud(() =>
    ok(
      dataFrame(msg.thinking('let me '), msg.thinking('think')),
      dataFrame(msg.text('Hello'), msg.text(' there'), msg.stop(2)),
      dataFrame(msg.usage({ input_tokens: 10, output_tokens: 20, cached_input_tokens: 300 })),
    ),
  );
  const { message, types } = await run(cloud, { reasoning: 'high' });

  assert.deepEqual(types, [
    'start',
    'thinking_start',
    'thinking_delta',
    'thinking_delta',
    'thinking_end',
    'text_start',
    'text_delta',
    'text_delta',
    'text_end',
    'done',
  ]);
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'let me think' },
    { type: 'text', text: 'Hello there' },
  ]);
  assert.equal(message.stopReason, 'stop');
  assert.equal(message.responseModel, 'claude-opus-5-5-high');
  assert.equal(message.providerThinkingLevel, 'high');
  assert.equal(message.usage.totalTokens, 330);
  assert.equal(message.usage.cacheRead, 300);
  assert.ok(message.usage.cost.total > 0);
});

test('tool calls parse their streamed arguments and stop with toolUse', async () => {
  const cloud = fakeCloud(() =>
    ok(
      dataFrame(msg.text('Reading.')),
      dataFrame(msg.toolStart('c1', 'read')),
      dataFrame(msg.toolArgs('{"path":"a'), msg.toolArgs('.ts"}')),
      dataFrame(msg.toolStart('c2', 'ls'), msg.toolArgs('{}')),
      dataFrame(msg.stop(2)), // a plain stop after tool calls still means toolUse
    ),
  );
  const { message, types } = await run(cloud);

  assert.equal(message.stopReason, 'toolUse');
  assert.deepEqual(message.content.slice(1), [
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
    { type: 'toolCall', id: 'c2', name: 'ls', arguments: {} },
  ]);
  assert.deepEqual(
    types.filter((t) => t.endsWith('_start') || t.endsWith('_end')),
    ['text_start', 'text_end', 'toolcall_start', 'toolcall_end', 'toolcall_start', 'toolcall_end'],
  );
});

test('a truncated answer stops with length', async () => {
  const cloud = fakeCloud(() => ok(dataFrame(msg.text('cut of'), msg.stop(3))));
  assert.equal((await run(cloud)).message.stopReason, 'length');
});

test('a transient failure before any output is retried', async () => {
  const cloud = fakeCloud((attempt) =>
    attempt === 0 ? new Response('busy', { status: 503 }) : ok(dataFrame(msg.text('ok'))),
  );
  const { message } = await run(cloud);
  assert.equal(message.stopReason, 'stop');
  assert.equal(cloud.calls.GetChatMessage, 2);
});

test('a rejected JWT is re-minted and the request retried', async () => {
  const cloud = fakeCloud((attempt) =>
    attempt === 0
      ? streamResponse([trailer({ code: 'unauthenticated', message: 'token expired' })])
      : ok(dataFrame(msg.text('ok'))),
  );
  const { message } = await run(cloud);
  assert.equal(message.stopReason, 'stop');
  assert.equal(cloud.calls.GetUserJwt, 2);
});

test('a failure after output has streamed is not retried', async () => {
  const cloud = fakeCloud(() =>
    streamResponse([dataFrame(msg.text('half')), trailer({ code: 'unavailable', message: 'backend died' })]),
  );
  const { message } = await run(cloud);
  assert.equal(cloud.calls.GetChatMessage, 1);
  assert.equal(message.stopReason, 'error');
  assert.equal(message.errorMessage, 'backend died');
  assert.deepEqual(message.content, [{ type: 'text', text: 'half' }]);
});

test('a permanent failure is reported without retrying', async () => {
  const cloud = fakeCloud(() => new Response('bad request', { status: 400 }));
  const { message, types } = await run(cloud);
  assert.equal(cloud.calls.GetChatMessage, 1);
  assert.deepEqual(types, ['error']);
  assert.match(message.errorMessage!, /HTTP 400/);
});

test('an abort is reported as aborted, not as an error', async () => {
  const controller = new AbortController();
  const cloud = fakeCloud(() => {
    queueMicrotask(() => controller.abort());
    return new Response(
      new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(dataFrame(msg.text('x')))) }),
    );
  });
  const { message } = await run(cloud, { signal: controller.signal });
  assert.equal(message.stopReason, 'aborted');
});

test('missing credentials fail with a sign-in hint', async () => {
  const { message } = await run(
    fakeCloud(() => ok()),
    { apiKey: undefined },
  );
  assert.match(message.errorMessage!, /\/login devin/);
});

test('the same session id yields the same conversation ids on every turn', async () => {
  const cloud = fakeCloud(() => ok(dataFrame(msg.text('ok'))));
  const payloads: { sessionId: string; cascadeId: string }[] = [];
  const onPayload = (payload: unknown): undefined => void payloads.push(payload as (typeof payloads)[number]);
  await run(cloud, { sessionId: 'session-a', onPayload });
  await run(cloud, { sessionId: 'session-a', onPayload });
  await run(cloud, { sessionId: 'session-b', onPayload });

  assert.match(
    payloads[0].sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(payloads[0], payloads[1]);
  assert.notEqual(payloads[0].sessionId, payloads[2].sessionId);
  assert.notEqual(payloads[0].sessionId, payloads[0].cascadeId);
});
