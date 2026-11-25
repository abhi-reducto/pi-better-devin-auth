/**
 * A fake Cognition cloud for tests: serves `GetUserJwt` and scripted
 * `GetChatMessage` responses through an injectable `fetch`.
 */

import { encodeMessage, encodeString, encodeVarintField } from '../src/cloud-direct/wire.js';

const b64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function fakeJwt(ttlSec = 1500): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + ttlSec, teams_tier: 'test' };
  return `${b64url({ alg: 'none' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

function envelope(flags: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Builders for the fields of one streamed `ChatMessage`. */
export const msg = {
  text: (s: string): Buffer => encodeString(3, s),
  thinking: (s: string): Buffer => encodeString(9, s),
  stop: (reason: number): Buffer => encodeVarintField(5, reason),
  toolStart: (id: string, name: string): Buffer =>
    encodeMessage(6, Buffer.concat([encodeString(1, id), encodeString(2, name)])),
  toolArgs: (delta: string): Buffer => encodeMessage(6, encodeString(3, delta)),
  usage(metrics: Record<string, number>): Buffer {
    const entries = Object.entries(metrics).map(([metric, value]) => {
      const float = Buffer.alloc(5);
      float[0] = (2 << 3) | 5; // field 2, fixed32
      float.writeFloatLE(value, 1);
      return encodeMessage(2, Buffer.concat([encodeMessage(4, float), encodeString(5, metric)]));
    });
    return encodeMessage(28, Buffer.concat(entries));
  },
};

export const dataFrame = (...fields: Buffer[]): Buffer => envelope(0, Buffer.concat(fields));
export const trailer = (error?: { code: string; message: string }): Buffer =>
  envelope(2, Buffer.from(JSON.stringify(error ? { error } : {})));

/** A streaming HTTP 200 whose body delivers `chunks` one at a time. */
export function streamResponse(chunks: Buffer[], init?: ResponseInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  return new Response(body, init);
}

export interface FakeCloud {
  fetch: typeof globalThis.fetch;
  /** Number of calls made per RPC name. */
  calls: Record<string, number>;
  /** Raw request bodies of the chat calls, in order. */
  chatBodies: Buffer[];
}

/** `chat` is called once per `GetChatMessage` request with its 0-based attempt number. */
export function fakeCloud(
  chat: (attempt: number, signal: AbortSignal | undefined) => Response | Promise<Response>,
): FakeCloud {
  const cloud: FakeCloud = {
    calls: {},
    chatBodies: [],
    fetch: async (input, init) => {
      const rpc = String(input).split('/').pop()!;
      cloud.calls[rpc] = (cloud.calls[rpc] ?? 0) + 1;
      if (rpc === 'GetUserJwt') return new Response(new Uint8Array(encodeString(1, fakeJwt())));
      if (rpc === 'GetChatMessage') {
        cloud.chatBodies.push(Buffer.from(init!.body as Uint8Array));
        return chat(cloud.calls[rpc] - 1, init?.signal ?? undefined);
      }
      return new Response('not found', { status: 404 });
    },
  };
  return cloud;
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
