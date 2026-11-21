import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterModelList, givenKey, plan, resolveKey, type Prefixes, type Settings } from "../src/routing.ts";
import { loadSettings, saveSettings, validateSettings } from "../src/settings.ts";
import { adminGuard } from "../src/admin.ts";

const prefixes: Prefixes = { claude: { "4router": "c4r", vercel: "cvc" }, gemini: { "4router": "g4r", vercel: "gvc" } };
const settings: Settings = { claude: "vercel", gemini: "4router", codexDisabled: ["gpt-6-luna"] };
const P = (o: Partial<Parameters<typeof plan>[0]>) => plan({ method: "POST", path: "/v1/messages", body: {}, scope: "all", settings, prefixes, ...o });

test("claude model gets the selected provider prefix, nothing else changes", () => {
  const p = P({ body: { model: "claude-haiku-5-5", max_tokens: 5, messages: [] } });
  assert.deepEqual(p, { ok: true, model: "claude-haiku-5-5", path: "/v1/messages", provider: "vercel", body: { model: "cvc/claude-haiku-5-5", max_tokens: 5, messages: [] } });
  const q = P({ body: { model: "claude-haiku-5-5" }, settings: { ...settings, claude: "4router" } });
  assert.equal(q.ok && q.body?.model, "c4r/claude-haiku-5-5");
});

test("gemini native path is rewritten, body untouched", () => {
  for (const action of [":generateContent", ":streamGenerateContent", ":countTokens"]) {
    const p = P({ path: `/v1beta/models/gemini-3.5-flash${action}`, body: { contents: [] }, scope: "gemini" });
    assert.deepEqual(p, { ok: true, model: "gemini-3.5-flash", path: `/v1beta/models/g4r/gemini-3.5-flash${action}`, provider: "4router" });
  }
  const v = P({ path: "/v1beta/models/gemini-2.5-flash:generateContent", settings: { ...settings, gemini: "vercel" } });
  assert.equal(v.ok && v.path, "/v1beta/models/gvc/gemini-2.5-flash:generateContent");
});

test("codex and other models pass through unchanged", () => {
  assert.deepEqual(P({ path: "/v1/responses", body: { model: "gpt-6-sol" } }), { ok: true, model: "gpt-6-sol", path: "/v1/responses", provider: "" });
  assert.deepEqual(P({ path: "/v1/chat/completions", body: { model: "opencode-free" } }), { ok: true, model: "opencode-free", path: "/v1/chat/completions", provider: "" });
});

test("disabled codex model is refused, including reasoning suffix", () => {
  for (const model of ["gpt-6-luna", "gpt-6-luna(high)"]) {
    const p = P({ path: "/v1/responses", body: { model } });
    assert.equal(p.ok, false);
    assert.equal(!p.ok && p.status, 403);
  }
});

test("client cannot pick the provider with an explicit prefix", () => {
  for (const model of ["c4r/claude-haiku-5-5", "cvc/claude-haiku-5-5"]) assert.equal(P({ body: { model } }).ok, false);
  assert.equal(P({ path: "/v1beta/models/gvc/gemini-2.5-flash:generateContent" }).ok, false);
  assert.equal(P({ path: "/v1beta/models/gvc%2Fgemini-2.5-flash:generateContent" }).ok, false);
  assert.equal(P({ path: "/v1/models/g4r/gemini-2.5-flash:countTokens", scope: "gemini" }).ok, false);
});

test("scoped keys only reach their family", () => {
  assert.equal(P({ scope: "claude", body: { model: "claude-haiku-5-5" } }).ok, true);
  assert.equal(P({ scope: "claude", body: { model: "gpt-6-sol" } }).ok, false);
  assert.equal(P({ scope: "codex", body: { model: "gpt-6-sol" } }).ok, true);
  assert.equal(P({ scope: "codex", body: { model: "claude-haiku-5-5" } }).ok, false);
  assert.equal(P({ scope: "gemini", path: "/v1beta/models/claude-x:generateContent" }).ok, false);
  assert.equal(P({ scope: "claude", body: { foo: 1 } }).ok, false, "POST without a model");
  assert.equal(P({ scope: "claude", method: "GET", path: "/v1/models", body: undefined }).ok, true, "listing");
  assert.equal(P({ scope: "all", body: { foo: 1 } }).ok, true);
});

test("givenKey and resolveKey", () => {
  const q = new URLSearchParams();
  assert.equal(givenKey({ authorization: "Bearer a" }, q), "a");
  assert.equal(givenKey({ "x-api-key": "b" }, q), "b");
  assert.equal(givenKey({ "x-goog-api-key": "c" }, q), "c");
  assert.equal(givenKey({}, new URLSearchParams("key=d&alt=sse")), "d");
  assert.equal(givenKey({}, q), "");
  const keys = [{ name: "x", scope: "all" as const, key: Buffer.from("k".repeat(40)) }, { name: "y", scope: "claude" as const, key: Buffer.from("j".repeat(40)) }];
  assert.equal(resolveKey("j".repeat(40), keys)?.name, "y");
  assert.equal(resolveKey("j".repeat(39), keys), undefined);
  assert.equal(resolveKey("", keys), undefined);
});

test("model listings show only the selected provider under plain names", () => {
  const data = { object: "list", data: ["c4r/claude-haiku-5-5", "cvc/claude-haiku-5-5", "cvc/claude-opus-5-5", "g4r/gemini-3.5-flash", "gvc/gemini-2.5-flash", "gpt-6-sol", "gpt-6-luna", "opencode-free"].map(id => ({ id })) };
  assert.deepEqual(filterModelList(data, settings, prefixes).data.map((m: any) => m.id), ["claude-haiku-5-5", "claude-opus-5-5", "gemini-3.5-flash", "gpt-6-sol", "opencode-free"]);
  const gem = { models: [{ name: "models/g4r/gemini-3.5-flash" }, { name: "models/gvc/gemini-2.5-flash" }, { name: "models/cvc/claude-haiku-5-5" }] };
  assert.deepEqual(filterModelList(gem, settings, prefixes).models.map((m: any) => m.name), ["models/gemini-3.5-flash", "models/claude-haiku-5-5"]);
});

test("settings: validation, defaults, atomic save with mode 600", () => {
  assert.throws(() => validateSettings({ claude: "openrouter", gemini: "4router", codexDisabled: [] }, prefixes));
  assert.throws(() => validateSettings({ claude: "4router", gemini: "4router" }, prefixes));
  assert.throws(() => validateSettings({ claude: "4router", gemini: "4router", codexDisabled: ["bad id!"] }, prefixes));
  assert.throws(() => validateSettings({ claude: "4router", gemini: "4router", codexDisabled: [], extra: 1 }, prefixes));
  assert.throws(() => validateSettings({ claude: "constructor", gemini: "4router", codexDisabled: [] }, prefixes));
  const dir = mkdtempSync(join(tmpdir(), "pag-settings-"));
  const f = join(dir, "settings.json");
  assert.deepEqual(loadSettings(f, prefixes), { claude: "4router", gemini: "4router", codexDisabled: [] });
  saveSettings(f, { claude: "vercel", gemini: "vercel", codexDisabled: ["gpt-6-luna"] });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(loadSettings(f, prefixes), { claude: "vercel", gemini: "vercel", codexDisabled: ["gpt-6-luna"] });
  writeFileSync(f, '{"claude":"nope"}');
  assert.throws(() => loadSettings(f, prefixes), "a broken file must not silently reset the provider");
  assert.ok(readFileSync(f, "utf8").includes("nope"));
});

test("admin guard: Serve peer, Host, Origin, Sec-Fetch-Site, JSON and CSRF token", () => {
  const cfg = { hosts: ["pag.ts.net:9446"], peers: ["100.1.1.1"] };
  const ok = { host: "pag.ts.net:9446", origin: "https://pag.ts.net:9446", "content-type": "application/json", "x-pag-csrf": "tok", "sec-fetch-site": "same-origin" };
  const G = (headers: Record<string, string>, o: { method?: string; remote?: string; api?: boolean } = {}) =>
    adminGuard({ method: o.method ?? "POST", headers, remote: o.remote ?? "::ffff:100.1.1.1", api: o.api ?? true }, cfg, "tok");
  assert.equal(G(ok), undefined);
  assert.ok(G(ok, { remote: "100.2.2.2" }), "direct tailnet peer, not via Serve");
  assert.ok(G({ ...ok, host: "evil.example" }), "DNS rebinding");
  assert.ok(G({ ...ok, origin: "https://evil.example" }), "cross-origin POST");
  assert.ok(G({ ...ok, origin: "http://pag.ts.net:9446" }), "plain http origin");
  const { origin, ...noOrigin } = ok; void origin;
  assert.ok(G(noOrigin), "missing Origin");
  assert.ok(G({ ...ok, "sec-fetch-site": "same-site" }));
  assert.ok(G({ ...ok, "content-type": "text/plain" }), "simple form/text request");
  assert.ok(G({ ...ok, "x-pag-csrf": "nope" }));
  assert.ok(G({ ...ok, "x-pag-csrf": "" }));
  assert.ok(G(ok, { method: "PUT" }));
  assert.equal(G({ host: "pag.ts.net:9446" }, { method: "GET", api: false }), undefined, "page navigation");
  assert.ok(G({ host: "pag.ts.net:9446", "sec-fetch-site": "cross-site" }, { method: "GET", api: true }));
});
