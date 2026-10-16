# Jev Core — Decision API

Standalone Node.js 20+ decision service and importable HTTP client. Jev Core owns provider keys, model selection, validation and failover. It has no dependency on a browser, AXI, vacancy workflows or scraping.

## Architecture

```text
better-axi / other clients -> jev-core SDK -> POST /v1/decisions -> provider/model pool
```

## Run a local server

```bash
git clone https://github.com/GitHubFoxy/Jev-core.git
cd Jev-core
export JEV_CORE_API_KEY='choose-a-long-random-secret'
export OPENROUTER_API_KEY='your-provider-key'
export JEV_OPENROUTER_MODELS='typesafe/jev-1.14,inception/mercury-decide:free'
npm start
```

The default bind is `127.0.0.1:8787`. Set `JEV_HOST` and `JEV_PORT` when necessary. Use HTTPS and enforce network-level access restrictions for remote use. The HTTP API requires a bearer key; only `GET /health` is unauthenticated. Never put provider keys in client apps.

## HTTP API

```http
POST /v1/decisions
Authorization: Bearer <JEV_CORE_API_KEY>
Content-Type: application/json

{
  "state": {"page": "Choose a tab"},
  "questions": {
    "operation": {
      "type": "choice",
      "criteria": {"OPEN": "Open the first tab", "WAIT": "Wait"},
      "instructions": "Pick the next action"
    }
  }
}
```

Success: `{"result":{"answers":{"operation":{"choice":"OPEN"}}},"provider":"openrouter","model":"typesafe/jev-1.14","latency_ms":123}`. Jev Core rejects invalid payloads (400), missing or invalid keys (401), absent provider configuration (503), unavailable model pools (502) and oversized bodies (413). Timeouts and provider errors are not forwarded to clients.

## ESM client

```bash
npm install 'jev-core@github:GitHubFoxy/Jev-core'
export JEV_CORE_URL=http://127.0.0.1:8787
export JEV_CORE_API_KEY='same-secret-as-the-server'
```
```js
import { requestDecision, validateChoice, createJevClient } from 'jev-core';
const { result, provider } = await requestDecision({
  state: { page: 'Example' },
  questions: { action: { type: 'choice', criteria: { YES: 'yes', NO: 'no' } } },
});
validateChoice(result.answers.action, { YES: 'yes', NO: 'no' });
// For dependency injection or tests:
const client = createJevClient({ baseUrl: process.env.JEV_CORE_URL, apiKey: process.env.JEV_CORE_API_KEY });
```

The client also preserves `mockHandler(payload)` and `validateResult(result)` options for deterministic integration tests. The server alone owns fallback behavior.

## Provider pool and priority

Configured routes are tried sequentially under a single deadline (default 25 seconds). Each comma-separated model list is tried in order, then the next provider. Absent credentials disable the provider.

| Provider | Required environment | Models (comma-separated, optional) |
| --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | `JEV_OPENROUTER_MODELS` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `JEV_GATEWAY_MODELS` |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | `JEV_CLOUDFLARE_MODELS` |

Optional `AI_GATEWAY_PROVIDER` selects a Vercel subprovider. The old `AI_GATEWAY_MODEL` and `CLOUDFLARE_AI_MODEL` are accepted as single-model fallbacks. See `docs/jev-model-allowances.md` for research (pricing changes; verify before production).

## Verify

```bash
npm test
```

API stability: `v1` is intentionally a minimal compatibility surface for Better AXI; production hardening should include deployment observability, quotas, explicit versioning and a persistent metering store.
