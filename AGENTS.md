# pi-better-devin-auth

Pi extension registering the `devin` provider (Cognition / Windsurf). Pi loads `extensions/index.ts`
directly via jiti, with `@earendil-works/*` imports resolved to Pi's own copies; `node_modules` here
exists only for type-checking and tests.

## Layout

```
extensions/index.ts     Entry: registers provider, sign-in, commands, session warm-up
src/stream.ts           streamSimple: request assembly, retry policy, error reporting
src/message-builder.ts  Chat events -> Pi AssistantMessage + stream events
src/context-map.ts      Pi transcript -> chat history (cache-stable, tool exchanges repaired)
src/models.ts           Model families, effort variants, live catalog overlay
src/oauth/              Browser sign-in and RegisterUser token exchange
src/cloud-direct/       Client for the Cognition API; knows nothing about Pi
  chat.ts               GetChatMessage streaming loop, timeouts
  request.ts            Request protobuf encoding
  response.ts           Response protobuf decoding, trailer parsing
  auth.ts               GetUserJwt mint + cache
  catalog.ts            GetCascadeModelConfigs fetch + cache
  metadata.ts           Metadata message sent with every RPC
  wire.ts               Protobuf primitives, Connect frame encoder/decoder
  types.ts, utils.ts    Shared types and helpers
tests/                  node:test suites; helpers.ts is a fake cloud
```

Dependencies point one way: `extensions` -> `src/*` -> `src/cloud-direct`. Keep Pi types out of
`cloud-direct`.

## Commands

```bash
npm run check       # prettier --check, tsc, tests: run before finishing any change
npm test
npm run format
```

## Conventions

- Protobuf is hand-encoded; there is no schema. Field numbers come from captures of Windsurf's
  traffic, so every encoder/decoder documents the message layout it assumes. Keep those comments
  accurate when touching a field.
- Errors from the cloud are `CloudChatError` with a Connect `code` or HTTP `status`. The retry policy
  in `stream.ts` keys off those; a new failure mode needs a code, not a message match.
- A request is retried only before any output has streamed.
- Anything that changes how history is encoded (`context-map.ts`, `request.ts`) changes the bytes of
  earlier turns and so invalidates Cognition's prompt cache for live sessions. Avoid it without cause.
- The model list in `models.ts` is deliberately limited to the families in `FAMILIES`.

## Verifying against the real service

```bash
pi -ne -e ./extensions/index.ts --no-mcp --no-session --no-tools \
   -p "Reply with exactly: OK" --model devin/claude-opus-5-5:low
```
