# pi-better-devin-auth

A [pi](https://pi.dev) extension that adds a `devin` provider: Cognition / Windsurf models, used
through your Windsurf subscription, with browser sign-in and native streaming.

This is a rewrite of [`nmzpy/pi-devin-auth`](https://github.com/nmzpy/pi-devin-auth) 0.1.2, whose
cloud client derives from [`opencode-windsurf-auth`](https://github.com/rsvedant/opencode-windsurf-auth).

## Install

```bash
pi install git:github.com/zhuasy/pi-better-devin-auth
```

Pi loads the TypeScript directly; there is no build step.

## Use

| Command                        | What it does                                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| `/login devin`                 | Opens Windsurf sign-in; paste the token the page shows back into Pi.  |
| `/model devin/claude-opus-5-5` | Pick a model. The thinking level selects the Cognition effort.        |
| `/devin-status`                | Account tier and remaining lifetime of the current session JWT.       |
| `/devin-refresh`               | Re-fetch the account's model catalog (limits, pricing, availability). |
| `/logout devin`                | Forget the stored API key.                                            |

Models come in two forms. A base model such as `claude-opus-5-5` follows Pi's thinking level (`low` to
`max`). A variant such as `claude-opus-5-5-high` is pinned to one effort.

## How it works

```
/login   windsurf.com sign-in ─ token ─▶ register.windsurf.com RegisterUser ─ api_key ─▶ ~/.pi/agent/auth.json
chat     Pi ─▶ streamDevin ─▶ server.codeium.com GetChatMessage (Connect-RPC stream) ─▶ Pi stream events
```

Each chat request sends the API key plus a short-lived user JWT (minted by `GetUserJwt`, cached in
memory, refreshed before it expires). Session and cascade ids are derived from Pi's session id, which is
what lets Cognition's prompt cache hit across turns and restarts.

## Things to know

- **Unofficial client.** The extension identifies itself to Cognition as the Windsurf IDE and speaks a
  protocol reconstructed from its traffic. It can break whenever Cognition changes that protocol, and
  using a subscription this way may be against Cognition's terms.
- **The API key is long-lived** and stored by Pi in `~/.pi/agent/auth.json`. It is only ever sent to
  the Cognition API server and never appears in logs or in the payload passed to `onPayload` hooks.
- **Personal accounts only.** Sign-in always uses the default region and API server; enterprise, EU
  and FedStart tenants are not supported.
- **Thinking is not replayed.** Cognition's wire format has no field for prior reasoning, so thinking
  blocks from earlier turns are dropped from the history.

## Develop

```bash
npm install
npm run check     # prettier + tsc + tests
```

Tests run offline against a fake cloud (`tests/helpers.ts`). See `AGENTS.md` for the layout.
