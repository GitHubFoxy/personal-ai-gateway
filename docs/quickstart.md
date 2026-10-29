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

## Gemini API key

Gemini's OpenAI-compatible API uses Chat Completions. Create an API key in [Google AI Studio](https://aistudio.google.com/app/apikey), then add it to PAG. OAuth for Antigravity is a separate path and is not used here.

~~~bash
pag auth add gemini
# Paste the key at the hidden prompt and press Enter.
pag auth models gemini
pag route set gemini llm gemini:gemini-3.8-flash
~~~

The built-in Gemini endpoint is `https://generativelanguage.googleapis.com/v1beta/openai/`. In Pi, use provider `pag-gemini` with API `openai-completions` and model alias `gemini`. Google's OpenAI compatibility is currently beta and may not expose every native Gemini feature.

## Vercel AI Gateway

Create an AI Gateway API key in the Vercel dashboard, then add it to PAG. Vercel's OpenAI-compatible endpoint supports model IDs in `provider/model` format. The Free Tier's $5 monthly credit applies only to eligible models; paid models in that list still consume the shared credit at their listed token rates.

~~~bash
pag auth add vercel
pag auth models vercel
pag route set coding llm vercel:anthropic/claude-sonnet-4.6
~~~

PAG uses `https://ai-gateway.vercel.sh/v1` for the `vercel` account. Replace the example model with an ID returned by `pag auth models vercel`.

For decision models, add a second account because PAG assigns one endpoint family to each account. Vercel's OpenAI-compatible Decisions API is now supported:

~~~bash
pag auth add vercel-decisions --kind decisions
pag auth models vercel-decisions
pag route set decision decisions vercel-decisions:convaiinnovations/laya-free
~~~

Replace `convaiinnovations/laya-free` with any decision-model ID available in the Vercel catalog, such as `typesafe-ai/jev-1.14.0`, `liquid/d1-ultra`, or `openai/gpt-6-luna-decisions`. Vercel's OpenAI Decisions API expects the same typed questions PAG accepts, so the gateway translates between the two formats. Vercel currently advertises Laya as free through October 31, 2026; after that, `laya-free` may stop serving and `laya` becomes paid.

## ChatGPT Plus / Pro via official Sign in with ChatGPT

PAG supports the documented open-source OAuth registration and token refresh flow (not ChatGPT web cookies). This is an **interactive** login; open the browser on the same machine where the CLI runs. Actual eligibility, consent and model access are decided by OpenAI.

~~~bash
npm run pag -- auth login openai
npm run pag -- auth models chatgpt
# Replace <model-from-account-catalog> with an actual slug listed above.
npm run pag -- route set coding llm chatgpt:<model-from-account-catalog> opencode-go:gpt-6-luna
~~~

ChatGPT OAuth uses streamed, unstored Responses upstream. Clients can use `POST /v1/responses` with `stream:true` and `store:false`, or `POST /v1/chat/completions` for non-streaming text messages. The chat adapter supports `max_tokens`, `response_format: {"type":"json_object"}`, and `reasoning.effort`; streaming chat, tools, images and other options require a native chat provider. Unsupported options are not silently discarded. PAG does not bypass per-plan/app limits. OAuth refresh tokens are stored in the local mode-0600 credential file; never copy it into a public repository. See [OpenAI's official OSS instructions](https://developers.openai.com/siwc/token-sharing-open-source).

**Limitation:** fallback works before a streamed response starts, not as an invisible continuation of an already emitted stream. Some ChatGPT quota errors may arrive as an SSE failure event after a stream starts; in that case PAG cannot safely replay that stream to another model. Check `response.failed` and retry as a fresh request if appropriate.

## Add a fallback

~~~bash
npm run pag -- auth add backup --kind llm --base-url https://openrouter.ai/api/v1 --key-stdin < openrouter-key.txt
npm run pag -- route set coding llm opencode-go:gpt-6-luna backup:some-available-model
npm run pag -- route promote coding backup:some-available-model
npm run pag -- route fallback coding on
npm run pag -- status
~~~

**Important:** A fallback target must support the requested features. The ChatGPT OAuth adapter supports only the chat subset described above; other providers must serve the requested endpoint directly. OpenCode Go models may support only one endpoint. Keep a stable `x-opencode-session` on coding-agent conversations and respect the provider's API usage policies.

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

## Docker

For a persistent local container (exposed to localhost only):

~~~bash
docker compose build
docker compose run --rm pag node --experimental-strip-types src/cli.ts init
docker compose run --rm -T pag node --experimental-strip-types src/cli.ts auth add opencode-go --key-stdin < opencode-key.txt
docker compose run --rm pag node --experimental-strip-types src/cli.ts route set coding llm opencode-go:gpt-6-luna
docker compose up -d
~~~

The `pag-state` volume contains **private API and OAuth credentials**; protect it. For ChatGPT's interactive OAuth login, running the CLI on the machine with the browser is simpler than a remote Docker container because the callback must use localhost.

## Limits and deliberate omissions

- The app exposes `/v1/responses`, `/v1/chat/completions`, `/v1/decisions`, `/v1/models` and `/healthz`. Existing OpenAI-compatible clients can use the PAG base URL with documented endpoint restrictions.
- Model pool is ordered. Fallback occurs on upstream authentication, credit, model-not-found, timeout, rate-limit or transient server errors, pre-response network errors, or invalid nonstream JSON. It cannot resume an interrupted stream. Configure only acceptable backup targets: PAG does not discover prices or models automatically.
- Provider quotas are not probed proactively; `status` shows configuration, not an invented token balance. Cooldowns are per-process and not durable. No usage billing/quota database.
- ChatGPT OAuth uses the official open-source dynamic-client PKCE login. The user must authorize plan usage, and the account must be eligible; live sign-in has not been validated in automated CI. Subscription traffic is restricted to streamed, unstored Responses.
- API-key providers work today; no provider calls are included in CI. This is not a general-purpose multi-user public gateway.
- Use localhost by default; if exposed remotely, terminate HTTPS at a trusted reverse proxy, secure PAG_HOME and keep the gateway API key private.
- YAML, UI, video/audio/images, and general-purpose model-protocol translation are intentionally deferred.
