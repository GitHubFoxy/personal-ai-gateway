# Personal AI Gateway (PAG)

**A small, local-first AI gateway for your own providers and supported subscriptions.**

Configure AI clients once with one gateway URL, one local API key and stable virtual model aliases such as **coding** and **decision**. Connect multiple providers centrally, reorder them with a CLI, and let the gateway automatically fall back to the next *compatible* provider when the first route hits a quota limit or transient failure.

> **Project status: planning / implementation ticket open.** This repository does not yet contain the finished PAG implementation.

## Why

You should not need to reconfigure every AI tool when you change a subscription, switch providers or run out of quota. PAG aims to be much smaller than a general AI gateway platform: just an API, provider adapters, ordered fallback and a CLI. No dashboard or database for the first version.

## Planned MVP

- OpenAI Responses-compatible endpoint for LLMs, plus a minimal Chat Completions-compatible interface.
- Dedicated Decisions endpoint with predicate, choice and score questions.
- Virtual models mapped to an ordered pool of compatible upstream routes.
- CLI to authenticate accounts, change priority, inspect status and control fallback.
- Officially supported provider integrations including API-key providers, OpenCode Go where permitted and eligible OAuth-based subscriptions. **A ChatGPT subscription is not an unrestricted platform API entitlement.**
- Local key/secrets store, no web admin UI or SQL database.

### Example of intended CLI (not implemented yet)

~~~sh
pag init
pag auth login openai
pag auth add opencode-go
pag route show coding
pag route set coding opencode-go/<supported-model>
pag route fallback coding on
pag status
pag serve
~~~

The app keeps using the same PAG key and model alias even if the actual provider changes.

## Roadmap

- [Issue #1: build the minimal PAG core](https://github.com/GitHubFoxy/Jev-core/issues/1).
- [Issue #3: future image, audio and video support](https://github.com/GitHubFoxy/Jev-core/issues/3).
- [Technical roadmap](PLAN.md).
- [Historical research on Decision models and free-tier quotas](docs/jev-model-allowances.md). Availability and pricing are time-sensitive.

## Design principles

1. **Small and auditable:** TypeScript/Bun, simple YAML routing, minimal dependencies.
2. **CLI-first:** no admin web UI, teams or complicated platform machinery.
3. **Consumer-independent:** no browser tools, job logic or agent workflows in the gateway.
4. **No surprise costs:** no paid-route fallback without explicit permission.
5. **No fake subscription support:** use documented auth/API integrations and respect each provider's permitted uses.
6. **Clear failure semantics:** route to another provider before streaming starts; never pretend to resume an interrupted stream seamlessly.

Media/image/video generation are future capabilities, not requirements of v0.1.
