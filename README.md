# Personal AI Gateway (PAG)

All LLM traffic goes through one place on `omarchy` (reachable over Tailscale only), and every request is stored in ClickHouse so agents can analyze how other agents behave.

```
agents ──► pag-front :8317 ──► CLIProxyAPI 127.0.0.1:8318 ──► OpenAI (Codex OAuth), 4router (Claude), OpenCode, …
              │   └─ /v1/decisions (own routes: Cloudflare Clef, Vercel Laya, OpenRouter Jev)
              └─► ClickHouse pag.requests (full request/response bodies)
```

- **CLIProxyAPI** (upstream binary, not forked) does providers, OAuth, account pools and the management UI.
- **pag-front** (`src/front.ts`, Node, no dependencies) records every POST and serves `/v1/decisions`, which CLIProxyAPI does not have. Credentials are masked in stored headers; bodies are stored as received.
- **Decisions** (`src/decisions.ts`) accepts System One (`state` + `questions{}`) and OpenAI-native (`input` + `questions[]`) requests and rotates between configured providers with fallback. See [docs/decisions.md](docs/decisions.md).
- **Provider switch** (`src/routing.ts`, `src/settings.ts`, `src/admin.ts`): Claude and Gemini each go to 4router or Vercel AI Gateway, chosen by hand at `https://omarchy.tail089ef.ts.net:9446/pag/`. See [docs/provider-switch.md](docs/provider-switch.md).
- **Querying**: the `pag-query` skill (`~/dotfiles/skills/pag-query`) runs read-only SQL via `ssh omarchy ~/pag/bin/pagq`.

## Files

The request log is available at `/pag/logs` through the same Tailscale Serve address as the provider page. It shows request metadata and supports filtering, sorting, and pagination. Configure `clickhouse.readUser` and `clickhouse.readPassFile` with a read-only ClickHouse account (see `config.example.json`).

| Path | Purpose |
|---|---|
| `schema.sql` | ClickHouse table |
| `config.example.json` | front config (copy to `~/pag/front/config.json` on omarchy) |
| `src/front.ts`, `src/capture.ts`, `src/decisions.ts` | the service |
| `deploy/` | systemd units, `pagq` (read-only SQL wrapper), CLIProxyAPI config with placeholders |

## Deploy (omarchy)

```sh
npm run check
scp src/*.ts omarchy:~/pag/front/src/ && ssh omarchy 'systemctl --user restart pag-front'
```

Services on omarchy (systemd user units): `pag-cpa` (CLIProxyAPI, `~/pag/cpa`), `pag-front` (`~/pag/front`); ClickHouse runs in Docker as `pag-clickhouse` with data in `~/pag/clickhouse`. Secrets live in `~/pag/cpa/secrets/` (mode 600).

## Point an agent at it

Each client has its own key in `~/pag/cpa/secrets/` (`pag-claude.key`, `pag-codex.key`, `pag-gemini.key`); a key only serves its model family. `client.key` keeps full access.

- Claude Code: `ANTHROPIC_BASE_URL=https://omarchy.tail089ef.ts.net:9446`, `ANTHROPIC_AUTH_TOKEN=<pag-claude.key>`. Use `claude-*` model names; requests reach the selected provider with the original Claude Code headers.
- Gemini CLI: `GOOGLE_GEMINI_BASE_URL=https://omarchy.tail089ef.ts.net:9446`, `GEMINI_API_KEY=<pag-gemini.key>`, auth type `gemini-api-key`.
- Codex: a model provider with `base_url = "https://omarchy.tail089ef.ts.net:9446/v1"`, `wire_api = "responses"`, key from `pag-codex.key`.

Known limits: rows are queued in memory and flushed every 2 s, so a crash can lose the last few seconds; stored bodies are capped at 32 MB each.
