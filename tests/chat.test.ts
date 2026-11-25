import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  clearCachedCatalog,
  clearCachedUserJwt,
  CloudChatError,
  streamChatEvents,
} from '../src/cloud-direct/index.js';
import { collapseSystemIntoUser } from '../src/cloud-direct/request.js';
import { collect, dataFrame, fakeCloud, msg, streamResponse, trailer } from './helpers.js';

const request = { apiKey: 'key', modelUid: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

beforeEach(() => {
  clearCachedUserJwt();
  clearCachedCatalog();
});

test('decodes text, thinking, tool calls, stop reason and usage', async () => {
  const cloud = fakeCloud(() =>
    streamResponse([
      dataFrame(msg.thinking('hmm')),
      dataFrame(msg.text('Hel'), msg.text('lo')),
      dataFrame(msg.toolStart('call_1', 'read')),
      dataFrame(msg.toolArgs('{"path":')),
      dataFrame(msg.toolArgs('"a"}'), msg.stop(10)),
      dataFrame(msg.usage({ input_tokens: 12, output_tokens: 34, cached_input_tokens: 100 })),
      trailer(),
    ]),
  );
  assert.deepEqual(await collect(streamChatEvents({ ...request, fetch: cloud.fetch })), [
    { kind: 'reasoning', text: 'hmm' },
    { kind: 'text', text: 'Hel' },
    { kind: 'text', text: 'lo' },
    { kind: 'tool_call_start', id: 'call_1', name: 'read' },
    { kind: 'tool_call_args', argsDelta: '{"path":' },
    { kind: 'tool_call_args', argsDelta: '"a"}' },
    { kind: 'finish', reason: 'tool_calls' },
    {
      kind: 'usage',
      promptTokens: 12,
      completionTokens: 34,
      cachedInputTokens: 100,
      cacheCreationInputTokens: undefined,
      reasoningTokens: undefined,
    },
  ]);
});

test('the user JWT is minted once and reused across requests', async () => {
  const cloud = fakeCloud(() => streamResponse([trailer()]));
  await collect(streamChatEvents({ ...request, fetch: cloud.fetch }));
  await collect(streamChatEvents({ ...request, fetch: cloud.fetch }));
  assert.equal(cloud.calls.GetUserJwt, 1);
  assert.equal(cloud.calls.GetChatMessage, 2);
});

test('a trailer error becomes a CloudChatError with code and trace id', async () => {
  const cloud = fakeCloud(() =>
    streamResponse([
      dataFrame(msg.text('partial')),
      trailer({ code: 'resource_exhausted', message: 'quota hit (trace ID: abc123)' }),
    ]),
  );
  await assert.rejects(
    collect(streamChatEvents({ ...request, fetch: cloud.fetch })),
    (err: CloudChatError) => {
      assert.equal(err.code, 'resource_exhausted');
      assert.equal(err.traceId, 'abc123');
      return true;
    },
  );
});

test('a stream that ends without a trailer is reported as truncated', async () => {
  const cloud = fakeCloud(() => streamResponse([dataFrame(msg.text('partial')), Buffer.from([0, 0, 0])]));
  await assert.rejects(
    collect(streamChatEvents({ ...request, fetch: cloud.fetch })),
    (err: CloudChatError) => err.code === 'truncated_stream' && /3 bytes/.test(err.message),
  );
});

test('an HTTP failure carries its status and Retry-After', async () => {
  const cloud = fakeCloud(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }));
  await assert.rejects(
    collect(streamChatEvents({ ...request, fetch: cloud.fetch })),
    (err: CloudChatError) => err.status === 429 && err.retryAfterMs === 7000,
  );
});

test("aborting mid-stream rejects with the caller's reason", async () => {
  const controller = new AbortController();
  const cloud = fakeCloud(() => {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(new Uint8Array(dataFrame(msg.text('first')))), // then silence
    });
    return new Response(body);
  });
  const events = streamChatEvents({ ...request, fetch: cloud.fetch, signal: controller.signal });
  assert.deepEqual((await events.next()).value, { kind: 'text', text: 'first' });
  const reason = new Error('user pressed escape');
  controller.abort(reason);
  await assert.rejects(events.next(), (err) => err === reason);
});

test('a server that never answers times out with a retryable error', async () => {
  const cloud = fakeCloud(
    (_attempt, signal) =>
      new Promise<Response>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason)),
      ),
  );
  await assert.rejects(
    collect(streamChatEvents({ ...request, fetch: cloud.fetch, firstByteTimeoutMs: 20 })),
    (err: CloudChatError) => err.code === 'deadline_exceeded' && /no response for 0.02s/.test(err.message),
  );
});

test('a stream that goes silent times out, even if fetch ignores the signal', async () => {
  const cloud = fakeCloud(() => {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(new Uint8Array(dataFrame(msg.text('first')))), // then silence
    });
    return new Response(body);
  });
  const events = streamChatEvents({ ...request, fetch: cloud.fetch, idleTimeoutMs: 20 });
  assert.deepEqual((await events.next()).value, { kind: 'text', text: 'first' });
  await assert.rejects(events.next(), (err: CloudChatError) => err.code === 'deadline_exceeded');
});

test('system messages are inlined into the following user message', () => {
  assert.deepEqual(
    collapseSystemIntoUser([
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
      { role: 'system', content: 'S3' },
    ]),
    [
      { role: 'user', content: [{ type: 'text', text: '<system>\nS1\n\nS2\n</system>\nU1' }] },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: '<system>\nS3\n</system>' },
    ],
  );
});
