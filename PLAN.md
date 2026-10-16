# Jev Core: REST Decision API (updated 2026-10-16)

## Goal

Provide one reusable decision control plane that can be consumed by any project over HTTPS. Keep model/provider pools and credentials on the Jev Core server; clients only know the service URL and an application API key.

## Boundary

- Jev Core owns: `POST /v1/decisions`, input/answer validation, provider request translation, model pools, ordered fallbacks, authentication and a small ESM HTTP client.
- Better AXI owns: browser/CDP adapter, navigation/action loop, vacancy-specific classification labels, job evaluation and CLI commands.
- No dependency from Jev Core back to Better AXI; no browser launch in the decision service.

## Migration

1. Build and test the standalone server and client.
2. Point Better AXI at Jev Core; keep browser-specific navigation and domain workflows in Better AXI.
3. Remove the local Jev provider code. Rename `core/jev` modules to reflect their actual responsibilities.
4. Add integration tests with an in-process test server and mocked upstream.
5. Deploy Jev Core, provision separate application API credentials, and verify end-to-end navigation against a real AXI session.
6. Tag releases and publish a stable npm client once deployments and provider compatibility are validated.

## Security and constraints

Never expose provider keys to clients; reject unauthenticated requests; bind to localhost by default; do not log user states or secret headers; cap request sizes and provider timeouts; no code execution.

## Non-goals for v1

Browser adapters, vacancy-specific evaluators, a durable execution engine, hosted dashboard, and a published npm release.
