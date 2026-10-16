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

## ChatGPT Plus / Pro via official Sign in with ChatGPT

PAG supports the documented open-source OAuth registration and token refresh flow (not ChatGPT web cookies). This is an **interactive** login; open the browser on the same machine where the CLI runs. Actual eligibility, consent and model access are decided by OpenAI.

~~~bash
npm run pag -- auth login openai
npm run pag -- auth models chatgpt
# Replace <model-from-account-catalog> with an actual slug listed above.
npm run pag -- route set coding llm chatgpt:<model-from-account-catalog> opencode-go:gpt-6-luna
~~~

For requests that may route through the ChatGPT subscription, clients **must use POST /v1/responses with `stream:true` and `store:false`**. This is the official plan-usage contract. Non-streaming and Chat Completions requests are routed only to other compatible accounts. PAG does not bypass per-plan/app limits. OAuth refresh tokens are stored in the local mode-0600 credential file; never copy it into a public repository. See [OpenAI's official OSS instructions](https://developers.openai.com/siwc/token-sharing-open-source).

**Limitation:** fallback works before a streamed response starts, not as an invisible continuation of an already emitted stream. Some ChatGPT quota errors may arrive as an SSE failure event after a stream starts; in that case PAG cannot safely replay that stream to another model. Check `response.failed` and retry as a fresh request if appropriate.

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
- Model pool is ordered. Fallback occurs on upstream 429, transient 5xx, pre-response network errors or invalid nonstream JSON. It cannot resume an interrupted stream.
- Provider quotas are not probed proactively; `status` shows configuration, not an invented token balance. Cooldowns are per-process and not durable. No usage billing/quota database.
- ChatGPT OAuth uses the official open-source dynamic-client PKCE login. The user must authorize plan usage, and the account must be eligible; live sign-in has not been validated in automated CI. Subscription traffic is restricted to streamed, unstored Responses.
- API-key providers work today; no provider calls are included in CI. This is not a general-purpose multi-user public gateway.
- Use localhost by default; if exposed remotely, terminate HTTPS at a trusted reverse proxy, secure PAG_HOME and keep the gateway API key private.
- YAML, UI, video/audio/images, and model-protocol translation are intentionally deferred.
