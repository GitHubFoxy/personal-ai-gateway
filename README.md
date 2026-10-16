# Personal AI Gateway (PAG)

Minimal, self-hosted **AI API router**: one gateway URL, one API key, stable virtual model aliases, ordered provider fallback, CLI configuration. TypeScript + Node.js 22.16+ with **zero production dependencies**. No dashboard, database, or LiteLLM.

**Implementation:** `src/`; [quick start](docs/quickstart.md); [project roadmap](PLAN.md).

### Features (v0.1)

- `POST /v1/responses` — forwards OpenAI Responses-compatible requests to a compatible model pool.
- `POST /v1/chat/completions` — forwards compatible chat completions requests.
- `POST /v1/decisions` — System One-style typed `predicate`, `choice`, `score` decisions.
- `GET /v1/models` — configured virtual aliases.
- Ordered fallback on 429, 5xx, network failures, cooldown and bounded timeout.
- SSE streaming pass-through (fallback **before** response begins only), preservation of tool payloads.
- Local `pag` CLI for provider keys, route selection, priority and health/config inspection.
- OpenCode Go and OpenRouter API-key examples; generic compatible provider endpoints.

~~~bash
npm install
npm run pag -- init
npm run pag -- auth add opencode-go --key-stdin < /path/to/keyfile
npm run pag -- route set coding llm opencode-go:gpt-6-luna
npm start
~~~

Use a stable alias `coding` with the generated PAG key at `http://127.0.0.1:4000/v1`. [Detailed steps and important provider restrictions](docs/quickstart.md).

**Subscription caveat:** ChatGPT Plus is not a normal OpenAI Platform API key. Official subscription OAuth requires its own consent/registration and eligibility; it is **not yet implemented**. Do not pass ChatGPT web session tokens to PAG. OpenCode Go requires coding-agent use and should receive stable `x-opencode-session` values.

See [#1 MVP](https://github.com/GitHubFoxy/Jev-core/issues/1) and [#3 future image/audio/video](https://github.com/GitHubFoxy/Jev-core/issues/3). Original Decision provider research is in [docs/jev-model-allowances.md](docs/jev-model-allowances.md).
