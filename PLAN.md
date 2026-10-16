# Jev Core Extraction Plan

## Goal

Extract the reusable Jev decision model from `better-axi` into a standalone, public project so other projects can install and import it without copying implementation code.

The intended consumer API is:

```js
const Jev = await import('jev');
```

The package should provide a decision model and reusable decision/navigation primitives. Provider credentials, provider selection, model defaults, request formatting, and fallback behavior belong inside Jev so consumers do not need to duplicate that logic.

## Current State

`better-axi` currently keeps Jev code under `core/jev`:

- `decision_client.mjs` calls OpenRouter Decisions, Vercel AI Gateway, and Cloudflare Workers AI, selecting available providers from environment variables and trying them in sequence.
- `loop.mjs` turns accessibility snapshots into candidate actions, asks Jev to choose the next step, and executes that action against a page adapter.
- `classifier.mjs` batches generic item-classification decisions, with labels and instructions currently oriented around vacancy screening.
- `evaluator.mjs` contains vacancy-specific scoring, hidden application-condition detection, and cover-letter drafting.

The navigation loop expects a page object with methods such as `snapshot`, `fill`, and `click`. `better-axi` supplies the browser integration; Jev should define and document the adapter contract without taking a dependency on `better-axi` or a particular browser client.

## Project Boundary

### Move into Jev

- Decision request API and answer validation.
- Provider integrations, credential lookup, model defaults, request translation, and ordered fallback behavior.
- Reusable snapshot parsing, action generation, action execution contract, and decision/navigation loop.
- Generic classification primitives where their API is not tied to a specific domain.

### Keep in better-axi

- Browser/CDP connection and the concrete page adapter.
- Vacancy-specific evaluation rules, candidate profiles, hidden-condition patterns, and cover-letter generation.
- `better-axi` CLI commands and workflow orchestration.

## Public API Direction

Expose a small ESM API from the package root. Preserve useful current names where practical, including `requestDecision`, `validateChoice`, `runNavigationLoop`, and generic classification helpers. Keep provider implementation details private unless users need a documented configuration option.

The API should support dependency injection for tests and custom integrations, including the existing mock decision handler pattern. Provider configuration should be explicit and documented, with environment-variable defaults as a convenience. Errors should identify which providers failed without exposing credentials.

Before publishing the package to npm under the name `jev`, check name availability and choose the package metadata and release process accordingly. The GitHub repository name is `Jev-core`; the intended import name remains `jev`.

## Migration Steps

1. Create the standalone ESM package and define its exported API and page-adapter contract.
2. Move the reusable decision client, navigation loop, and generic classifier into the package, preserving behavior and tests.
3. Keep vacancy evaluation and cover-letter logic in `better-axi`; remove the Jev copies from that repository.
4. Replace `better-axi` relative imports with the `jev` package dependency and adapt its CLI/workflow integration.
5. Verify the existing navigation, decision-client, and classifier behavior through the package, including mocked provider tests and provider fallback cases.
6. Document installation, configuration keys, provider ordering, fallback behavior, API examples, and supported Node.js versions.
7. Publish and version the package only after `better-axi` consumes the standalone package successfully.

## Compatibility and Security

- Keep browser control behind the documented page adapter; Jev should not silently launch or attach to a browser.
- Preserve input validation and fail clearly when no provider is configured or all providers fail.
- Never log API keys or include them in provider error messages.
- Keep navigation action execution constrained to the supplied adapter methods; do not add dynamic code execution.
- Treat API and provider changes as versioned public-interface changes.

## Out of Scope

- Moving vacancy-specific business rules into the shared package.
- Owning CDP/browser setup inside Jev.
- Publishing to npm as part of this initial planning commit.
