# Personal AI Gateway (PAG) — Project Plan

> **Status:** design + v0.1 MVP specification. This supersedes the former "Jev Core Extraction Plan". The project is a new, independent gateway, NOT an extraction of code from better-axi or another application.

**Primary implementation issue:** [#1 — Build Personal AI Gateway v0.1](https://github.com/GitHubFoxy/Jev-core/issues/1) (GitHub may redirect the link after a repository rename).

## What PAG does

Personal AI Gateway is a **local-first, self-hosted API router** that lets a user connect supported AI subscriptions, provider API keys and free-tier model routes to one stable gateway. Apps configure **one base URL, one gateway API key, and durable virtual model aliases** such as coding and decision.

The user can change route priority through a CLI; the apps never need to rotate their own credentials or reconfigure model names. PAG can automatically fail over to the next compatible upstream when a provider is unavailable or a genuine quota limit is reached. It must not pretend a subscription is equivalent to an unrestricted API entitlement.

PAG is deliberately **small and understandable**. No dashboard or multi-tenant SaaS.

## MVP scope (v0.1)

1. **LLMs**: OpenAI Responses-compatible endpoint (main), minimal Chat Completions-compatible endpoint for broad client compatibility, including streaming and tool calls when a chosen provider truly supports them.
2. **Decisions**: separate endpoint for small, structured predicate, choice and score decisions.
3. **Model aliases**: named capability-typed route groups, with deterministic ordered target list, manual priority switching and bounded automatic fallback.
4. **Authentication**: local PAG API key, upstream provider tokens stored separately, no exposure to applications.
5. **Providers**: documented, permitted OAuth/subscription integrations where available, OpenCode Go via its official API, generic OpenAI-compatible API-key providers, and verified Decisions providers. Never use undocumented subscription APIs or circumvent usage restrictions.
6. **CLI**: init, serve, auth add/login/list/remove, route list/show/set/fallback, status, doctor.
7. **Deployment and quality**: Bun/TypeScript with Hono, YAML configuration, secure secret storage, no database/dashboard, tests and reproducible local setup.

**Non-goals:** browser automation, job workflows, agent harness, consumer migrations, UI, analytics dashboard, billing, organizations, teams, Kubernetes, Redis, SQL, optimizing costs with complicated heuristics, npm publishing, hosting models.

## Architecture

~~~text
Client app 1 ----\
Client app 2 -----+--> PAG HTTP API -- Auth -- Alias resolver -- Capability filter
Client app 3 ----/                                      |
                                              Ordered fallback router
                                                /      |        \
                                        OAuth / API-key provider adapters
                                                \      |        /
                                       Normalized / forwarded responses
~~~

**Protocol types must remain separate:** LLM output is not interchangeable with a typed Decision result. Future image/video/audio providers are new capability groups, not more fallback candidates for text.

## API

- POST /v1/responses — primary LLM API.
- POST /v1/chat/completions — minimal compatible LLM API.
- POST /v1/decisions — structured decision API using state + questions.
- GET /v1/models — configured virtual models and capabilities.
- GET /healthz — local process liveness without inference.

Authenticate all /v1 endpoints using a PAG-issued local bearer token. Use a stable virtual model alias such as coding for all applications. A different actual upstream model may answer when routed through that alias; this must be explicit and documented.

## Example configuration (model identifiers are placeholders)

~~~yaml
server:
  host: 127.0.0.1
  port: 4000

routes:
  coding:
    type: llm
    targets:
      - account: chatgpt
        model: <supported-model>
      - account: opencode-go
        model: <supported-model>
  decision:
    type: decisions
    targets:
      - account: openrouter
        model: <supported-decision-model>

fallback:
  enabled: true
  max_attempts: 3
  cooldown_seconds: 60
~~~

Route changes via CLI should affect **new requests**, without reconfiguring connected applications. Secrets do not go in the YAML.

## Correctness rules

- Fallback on quota/rate-limit errors, transient outages and recoverable timeouts **before a response stream starts**. Never silently switch providers after output has already streamed.
- Reject incompatible target capabilities (tools, streaming, structured output, context limit, question types) rather than degrade silently.
- No invented provider quotas, costs or confidence scores. Health/status may show "unknown" when no supported quota endpoint exists.
- Respect each provider's official authentication scheme, subscription permissions and model availability. A ChatGPT Plus subscription is not an OpenAI Platform API key.
- Bounded retries; observable route choice and errors; no secret leakage, no untrusted upstream URL from client requests.
- Keep the code local-first, small, modular and testable; no databases or web dashboard unless future requirements demonstrably require one.

## Milestones

**M0:** Reconcile official provider capabilities, implement skeleton and secure auth/config.

**M1:** Functional LLM endpoint + mock provider + streaming tests.

**M2:** Model aliases, CLI switching, automatic fallback and cooldown tests.

**M3:** Real supported upstream adapters (OpenCode Go, API-key models, eligible documented OAuth flows) and standardized Decision endpoint.

**M4:** End-to-end tests, secure local secret storage, documentation, release-ready source.

**Later:** Media adapters for image/audio/video, independent capability pools, asynchronous video jobs, and separate downstream consumer migrations.

## Repository documentation

- [Decision model/free-tier research](docs/jev-model-allowances.md) is retained as provider research. Its model IDs, prices and free quotas are time-sensitive and must be rechecked before enabling routes.
- [Implementation ticket #1](https://github.com/GitHubFoxy/Jev-core/issues/1) provides the executable checklist, CLI commands, detailed failure semantics and acceptance tests.

The repository can be renamed to **personal-ai-gateway**, but the technical spec does not depend on the rename happening before implementation.
