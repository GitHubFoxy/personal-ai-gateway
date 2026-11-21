/**
 * Client keys, model families and the manual provider switch.
 *
 * Claude and Gemini each have two upstreams in CLIProxyAPI, kept apart by a
 * credential prefix (e.g. `c4r/claude-…` vs `cvc/claude-…`) with
 * `routing.force-model-prefix: true`. PAG picks the prefix from the saved
 * settings, so CLIProxyAPI only ever sees one provider per request and never
 * falls back to the other one. Codex models are only switched on/off.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type Family = "claude" | "gemini" | "codex";
export type Scope = Family | "all";
export type Switchable = "claude" | "gemini";
export const SWITCHABLE: readonly Switchable[] = ["claude", "gemini"];

/** Provider name -> CLIProxyAPI credential prefix, per switchable family. */
export type Prefixes = Record<Switchable, Record<string, string>>;
export type Settings = { claude: string; gemini: string; codexDisabled: string[] };
export type ClientKey = { name: string; scope: Scope; key: Buffer };

export function family(model: string): Family | undefined {
  if (/^claude-/i.test(model)) return "claude";
  if (/^gemini-/i.test(model)) return "gemini";
  if (/^(gpt-|codex-)/i.test(model)) return "codex";
  return undefined;
}

/** Codex accepts reasoning suffixes like `gpt-6-sol(high)`; toggles apply to the base name. */
export const baseModel = (model: string) => model.replace(/\([^()]*\)$/, "");

/** The key a client sent: Bearer, x-api-key, x-goog-api-key, then Gemini's `?key=`. */
export function givenKey(h: IncomingHttpHeaders, query: URLSearchParams): string {
  const bearer = String(h.authorization ?? "").replace(/^Bearer\s+/i, "");
  for (const v of [bearer, h["x-api-key"], h["x-goog-api-key"], query.get("key")]) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export function resolveKey(given: string, keys: ClientKey[]): ClientKey | undefined {
  const a = Buffer.from(given);
  let hit: ClientKey | undefined;
  for (const k of keys) if (a.length === k.key.length && timingSafeEqual(a, k.key)) hit = k;
  return hit;
}

const GEMINI_PATH = /^(\/v1(?:beta)?\/models\/)([^:]+)(:[A-Za-z]+)$/;

export type Plan =
  | { ok: false; status: number; error: string; model: string }
  | { ok: true; model: string; path: string; body?: Record<string, unknown>; provider: string };

/**
 * Decide what to forward for one request. Never substitutes another model or
 * provider: an unknown model is passed on and CLIProxyAPI rejects it.
 */
export function plan(req: { method: string; path: string; body: unknown; scope: Scope; settings: Settings; prefixes: Prefixes }): Plan {
  const g = GEMINI_PATH.exec(req.path);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : undefined;
  let model = "";
  if (g) { try { model = decodeURIComponent(g[2]); } catch { model = g[2]; } }
  else if (typeof body?.model === "string") model = body.model;
  const fail = (status: number, error: string): Plan => ({ ok: false, status, error, model });

  const allPrefixes = SWITCHABLE.flatMap(f => Object.values(req.prefixes[f]));
  const slash = model.indexOf("/");
  if (slash > 0 && allPrefixes.includes(model.slice(0, slash))) {
    return fail(400, `PAG chooses the provider; send the plain model name instead of "${model}"`);
  }
  const fam = model ? family(model) : undefined;
  if (req.scope !== "all") {
    if (!model && req.method !== "GET") return fail(403, `this PAG key only serves ${req.scope} models and the request names no model`);
    if (model && fam !== req.scope) return fail(403, `this PAG key only serves ${req.scope} models, not "${model}"`);
  }
  if (model && req.settings.codexDisabled.includes(baseModel(model))) {
    return fail(403, `model "${baseModel(model)}" is disabled in PAG`);
  }
  if (fam !== "claude" && fam !== "gemini") return { ok: true, model, path: req.path, provider: "" };

  const provider = req.settings[fam];
  const prefix = req.prefixes[fam][provider];
  if (!prefix) return fail(500, `no CLIProxyAPI prefix configured for ${fam} provider "${provider}"`);
  const routed = `${prefix}/${model}`;
  if (g) return { ok: true, model, path: g[1] + routed + g[3], provider };
  return { ok: true, model, path: req.path, body: { ...body, model: routed }, provider };
}

/**
 * Model listings: show Claude/Gemini models of the selected provider under
 * their plain names, hide the other provider and disabled Codex models.
 */
export function filterModelList(json: any, settings: Settings, prefixes: Prefixes): any {
  const selected = new Set(SWITCHABLE.map(f => prefixes[f][settings[f]]));
  const known = new Set(SWITCHABLE.flatMap(f => Object.values(prefixes[f])));
  const map = (id: string, lead = ""): string | undefined => {
    const rest = id.slice(lead.length);
    const slash = rest.indexOf("/");
    const p = slash > 0 ? rest.slice(0, slash) : "";
    if (known.has(p)) return selected.has(p) ? lead + rest.slice(slash + 1) : undefined;
    return settings.codexDisabled.includes(baseModel(rest)) ? undefined : id;
  };
  if (Array.isArray(json?.data)) {
    return { ...json, data: json.data.flatMap((m: any) => { const id = typeof m?.id === "string" ? map(m.id) : m?.id; return id === undefined ? [] : [{ ...m, id }]; }) };
  }
  if (Array.isArray(json?.models)) {
    return { ...json, models: json.models.flatMap((m: any) => {
      if (typeof m?.name !== "string") return [m];
      const name = map(m.name, m.name.startsWith("models/") ? "models/" : "");
      return name === undefined ? [] : [{ ...m, name }];
    }) };
  }
  return json;
}
