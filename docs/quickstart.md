# PAG v0.1 quick start

PAG is a small Node 22.16+ TypeScript gateway; it also runs on Bun. No database or dashboard.

## Set up

~~~bash
npm install
npm run pag -- init
# Copy the one-time pag_... key into your client configuration.

# An OpenCode Go subscription has an official API key. The example model/endpoint
# must match the latest provider catalog and permissible coding-agent traffic.
npm run pag -- auth add opencode-go --kind llm --base-url https://opencode.ai/zen/go/v1 --key-stdin < opencode-key.txt
npm run pag -- route set coding llm opencode-go:gpt-6-luna
npm start
~~~

Pass the gateway API key via `Authorization: Bearer pag_...`:

~~~bash
curl http://127.0.0.1:4000/v1/responses \
  -H "Authorization: Bearer $PAG_KEY" \
  -H "Content-Type: application/json" \
  -H "x-opencode-session: my-conversation-id" \
  -d '{"model":"coding","input":"Hello"}'
~~~

PAG maps the stable alias `coding` to the configured provider/model. Clients do not need to change keys or model names when the route is reordered.

## Add a fallback

~~~bash
npm run pag -- auth add backup --kind llm --base-url https://openrouter.ai/api/v1 --key-stdin < openrouter-key.txt
npm run pag -- route set coding llm opencode-go:gpt-6-luna backup:some-available-model
npm run pag -- route promote coding backup:some-available-model
npm run pag -- route fallback coding on
npm run pag -- status
~~~

**Important:** A fallback target must serve the *same endpoint* and support the requested features. Responses and Chat Completions are deliberately kept separate; PAG does not automatically and lossily translate between them. OpenCode Go models may support only one of these endpoints. Use an appropriate alias/endpoint for each model. Keep a stable `x-opencode-session` on coding-agent conversations and respect the provider's API usage policies.

## Decisions

~~~bash
npm run pag -- auth add openrouter-decisions --kind decisions --decisions-url https://openrouter.ai/api/alpha/decisions --key-stdin < openrouter-key.txt
npm run pag -- route set decision decisions openrouter-decisions:typesafe/jev-1.14
curl http://127.0.0.1:4000/v1/decisions \
  -H "Authorization: Bearer $PAG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"decision","state":"Checkout is broken","questions":{"urgent":{"type":"predicate","instructions":"Is this urgent?"}}}'
~~~

Decision models use System One-style `state` + `questions`. PAG translates public `predicate` to upstream `noul`, and validates choice/rubric answers. Model IDs and route availability are subject to change.

## CLI

`pag init`, `pag serve`, `pag auth add/list/remove`, `pag route set/show/list/promote/fallback`, `pag status`, `pag doctor`. With npm scripts: `npm run pag -- ...`. Config is JSON in `~/.config/pag/config.json` (override with `PAG_HOME`), upstream tokens in private mode-0600 `secrets.json`. `PAG_HOST`/`PAG_PORT` override the bind address and port. Changes to routes affect **new** requests immediately.

## Limits and deliberate omissions

- The app exposes `/v1/responses`, `/v1/chat/completions`, `/v1/decisions`, `/v1/models` and `/healthz`. Existing OpenAI-compatible clients can use the PAG base URL with documented endpoint restrictions.
- Model pool is ordered. Fallback occurs on upstream 429, transient 5xx, pre-response network errors or invalid nonstream JSON. It cannot resume an interrupted stream.
- Provider quotas are not probed proactively; `status` shows configuration, not an invented token balance. Cooldowns are per-process and not durable. No usage billing/quota database.
- No ChatGPT Plus OAuth is implemented in v0.1. It requires approved official Sign in with ChatGPT client registration and permitted Responses API scopes; subscriber cookies or undocumented endpoints are not acceptable alternatives.
- API-key providers work today; no provider calls are included in CI. This is not a general-purpose multi-user public gateway.
- Use localhost by default; if exposed remotely, terminate HTTPS at a trusted reverse proxy, secure PAG_HOME and keep the gateway API key private.
- YAML, UI, video/audio/images, and model-protocol translation are intentionally deferred.
