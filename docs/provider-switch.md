# Provider switch

Claude and Gemini traffic goes to one provider at a time: 4router or Vercel AI Gateway. You choose it at `https://omarchy.tail089ef.ts.net:9446/pag/`. Codex always uses the ChatGPT OAuth credential; the page only turns Codex models on and off.

## How it works

1. CLIProxyAPI has a credential per provider, each with a prefix: `c4r`/`cvc` for Claude, `g4r`/`gvc` for Gemini. `routing.force-model-prefix: true` means a prefixed model only matches that one credential.
2. pag-front reads `front/settings.json` and rewrites `claude-haiku-5-5` to `cvc/claude-haiku-5-5` (Gemini native: the model segment of `/v1beta/models/<model>:<action>`). Clients cannot send a prefix themselves.
3. Each credential has an explicit model list. A model the selected provider does not have returns `unknown provider for model …`; PAG never substitutes another model or provider.
4. These credentials use `request-retry: 0` and `disable-cooling: true`: one attempt, the upstream error goes back to the client, the next request tries again.

A change applies to the next request, including in open conversations. Requests already in flight finish on the provider they started with. Nothing switches automatically.

Vercel model names differ (`anthropic/claude-haiku-5.5`, `google/gemini-2.5-flash`); CLIProxyAPI maps them with `models[].alias`. Vercel's native Gemini API returned 404, so Gemini requests to Vercel go through its OpenAI-compatible endpoint and CLIProxyAPI translates them.

## Keys

| Key file | Serves |
|---|---|
| `client.key` | everything (old key, unchanged; also `/v1/decisions`) |
| `pag-claude.key` | `claude-*` |
| `pag-gemini.key` | `gemini-*` |
| `pag-codex.key` | `gpt-*`, `codex-*` |

PAG accepts the key as `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, or `?key=`. It replaces the key with `client.key` before calling CLIProxyAPI. Provider keys stay in CLIProxyAPI's config. A request with an unknown key is forwarded untouched, so CLIProxyAPI rejects it as before; the management panel keeps working. The ClickHouse log records the key name (`x-pag-key` in `req_headers`) and the provider (`upstream`).

## Page security

There is no password. The page answers only through Tailscale Serve (`admin.peers` is the local tailnet address that Serve connects from, `admin.hosts` the Serve host). A change must be a `POST` with JSON, `Origin: https://<host>`, `Sec-Fetch-Site: same-origin` when the browser sends it, and the per-process CSRF token from the page. The page sends a CSP with a per-request nonce and denies framing. Changes are logged to the journal with the `Tailscale-User-Login`.

Processes on omarchy itself can reach the page directly on `:8317`; they can read the secrets anyway.

## Change the model lists

Edit the lists in `deploy/make-cpa-config.py`, then:

```sh
python3 -I deploy/make-cpa-config.py /tmp/cpa-test/config.yaml 18319 /tmp/cpa-test/auth   # try it on a spare instance
python3 -I deploy/make-cpa-config.py ~/pag/cpa/config.yaml.new && mv ~/pag/cpa/config.yaml.new ~/pag/cpa/config.yaml
systemctl --user restart pag-cpa
```
