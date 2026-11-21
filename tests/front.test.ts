/**
 * Runs the real front against a fake CLIProxyAPI: key separation, provider
 * switch through the page API, in-flight requests, persistence, CSRF guards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const K = { legacy: "L".repeat(48), claude: "C".repeat(48), codex: "X".repeat(48), gemini: "G".repeat(48) };
const HOST = "pag.test:9446";

type Seen = { path: string; model?: string; auth: string; xApiKey?: string; goog?: string };
const seen: Seen[] = [];
const fake = http.createServer((req, res) => {
  let b = "";
  req.on("data", c => (b += c));
  req.on("end", () => {
    let model: string | undefined;
    try { model = JSON.parse(b).model; } catch { /* no body */ }
    seen.push({ path: req.url ?? "", model, auth: String(req.headers.authorization ?? ""), xApiKey: req.headers["x-api-key"] as string, goog: req.headers["x-goog-api-key"] as string });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "c4r/claude-haiku-5-5" }, { id: "cvc/claude-haiku-5-5" }, { id: "gpt-6-sol", owned_by: "openai" }, { id: "gpt-6-luna", owned_by: "openai" }] }));
    }
    const delay = model?.includes("slow") ? 400 : 0;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ model })}\n\n`);
    setTimeout(() => res.end("data: done\n\n"), delay);
  });
});

let front: ChildProcess;
let port = 0;
const dir = mkdtempSync(join(tmpdir(), "pag-front-"));

async function startFront(): Promise<void> {
  front = spawn(process.execPath, ["src/front.ts"], { env: { ...process.env, PAG_FRONT_CONFIG: join(dir, "config.json") }, stdio: ["ignore", "pipe", "pipe"] });
  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    front.stdout!.on("data", d => { out += d; const m = /pag-front on [^:]+:(\d+)/.exec(out); if (m) resolve(+m[1]); });
    front.stderr!.on("data", d => { if (!String(d).includes("clickhouse")) process.stderr.write(d); });
    front.on("exit", code => reject(new Error(`front exited ${code}: ${out}`)));
  });
}
const stopFront = () => new Promise<void>(r => { front.once("exit", () => r()); front.kill("SIGTERM"); });

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, ...(data ? { "content-type": "application/json" } : {}), ...headers } }, res => {
      let t = "";
      res.on("data", c => (t += c));
      res.on("end", () => { let j; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, text: t, json: j }); });
    });
    r.on("error", reject);
    r.end(data);
  });
}
const msg = (key: string, model: string) => call("POST", "/v1/messages", { "x-api-key": key }, { model, max_tokens: 5, messages: [] });
const last = () => seen[seen.length - 1];

let csrf = "";
async function getCsrf() {
  const page = await call("GET", "/pag/");
  assert.equal(page.status, 200);
  csrf = /const CSRF="([^"]+)"/.exec(page.text)![1];
}
const adminPost = (body: unknown, extra: Record<string, string> = {}) =>
  call("POST", "/pag/api/settings", { origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "x-pag-csrf": csrf, ...extra }, body);

test.before(async () => {
  await new Promise<void>(r => fake.listen(0, "127.0.0.1", () => r()));
  for (const [n, v] of Object.entries(K)) writeFileSync(join(dir, `${n}.key`), v + "\n");
  writeFileSync(join(dir, "ch.pass"), "x");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    listen: { host: "127.0.0.1", port: 0 },
    upstream: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
    clientKeyFile: join(dir, "legacy.key"),
    clientKeys: (["claude", "codex", "gemini"] as const).map(n => ({ name: n, scope: n, file: join(dir, `${n}.key`) })),
    providers: { claude: { "4router": "c4r", vercel: "cvc" }, gemini: { "4router": "g4r", vercel: "gvc" } },
    settingsFile: join(dir, "settings.json"),
    admin: { hosts: [HOST], peers: ["127.0.0.1"] },
    clickhouse: { url: "http://127.0.0.1:9", user: "x", passFile: join(dir, "ch.pass") },
    decisions: { alias: "decision", routes: [] },
  }));
  await startFront();
});
test.after(async () => { await stopFront(); fake.close(); });

test("legacy key still works and reaches the default provider; client key is replaced", async () => {
  const r = await msg(K.legacy, "claude-haiku-5-5");
  assert.equal(r.status, 200);
  assert.equal(last().model, "c4r/claude-haiku-5-5");
  assert.equal(last().auth, `Bearer ${K.legacy}`, "front talks to CLIProxyAPI with the legacy (upstream) key");
  const g = await call("POST", "/v1/responses", { authorization: `Bearer ${K.legacy}` }, { model: "gpt-6-sol" });
  assert.equal(g.status, 200);
  assert.equal(last().model, "gpt-6-sol");
});

test("scoped keys: own family only, own key never forwarded", async () => {
  assert.equal((await msg(K.claude, "claude-haiku-5-5")).status, 200);
  assert.equal(last().auth, `Bearer ${K.legacy}`);
  assert.equal(last().xApiKey, undefined);
  const n = seen.length;
  const denied = await msg(K.claude, "gpt-6-sol");
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.type, "permission_error");
  assert.equal((await call("POST", "/v1/responses", { authorization: `Bearer ${K.codex}` }, { model: "claude-haiku-5-5" })).status, 403);
  assert.equal(seen.length, n, "refused requests never reach CLIProxyAPI");
  const gm = await call("POST", "/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=" + K.gemini, {}, { contents: [] });
  assert.equal(gm.status, 200);
  assert.equal(last().path, "/v1beta/models/g4r/gemini-3.5-flash:streamGenerateContent?alt=sse");
  assert.equal(last().goog, undefined);
  assert.equal((await call("POST", "/v1beta/models/gemini-3.5-flash:generateContent", { "x-goog-api-key": K.gemini }, { contents: [] })).status, 200);
});

test("unknown key is passed through untouched (CLIProxyAPI decides, as before)", async () => {
  await msg("wrong-key", "claude-haiku-5-5");
  assert.equal(last().model, "claude-haiku-5-5");
  assert.equal(last().xApiKey, "wrong-key");
});

test("page guards", async () => {
  await getCsrf();
  const body = { claude: "vercel" };
  assert.equal((await adminPost(body, { origin: "https://evil.example" })).status, 403);
  assert.equal((await adminPost(body, { "x-pag-csrf": "nope" })).status, 403);
  assert.equal((await adminPost(body, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await adminPost(body, { host: "evil.example" })).status, 403);
  assert.equal((await call("POST", "/pag/api/settings", { origin: `https://${HOST}`, "x-pag-csrf": csrf, "content-type": "text/plain" }, JSON.stringify(body))).status, 403);
  assert.equal((await adminPost({ claude: "openrouter" })).status, 422);
  assert.equal((await adminPost({ claude: "vercel", sneaky: true })).status, 422);
  const st = await call("GET", "/pag/api/state");
  assert.equal(st.json.settings.claude, "4router", "nothing changed so far");
  assert.deepEqual(st.json.providers.claude.map((p: any) => p.name), ["4router", "vercel"]);
  assert.deepEqual(st.json.codexModels, ["gpt-6-luna", "gpt-6-sol"]);
  assert.ok(!st.text.includes(K.legacy) && !st.text.includes(K.claude), "state never contains key values");
  const html = await call("GET", "/pag/");
  for (const k of Object.values(K)) assert.ok(!html.text.includes(k));
  assert.equal((await call("GET", "/pag/logs", { host: "evil.example" })).status, 403);
  assert.equal((await call("GET", "/pag/api/logs", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call("GET", "/pag/api/logs?sort=evil")).status, 400);
  assert.equal((await call("GET", "/pag/logs")).status, 200);
  assert.equal((await call("GET", "/pag/api/logs")).status, 503);
});

test("switch applies to the next request; an in-flight request finishes on its provider", async () => {
  await getCsrf();
  const inflight = msg(K.claude, "claude-slow");
  await new Promise(r => setTimeout(r, 100));
  const sw = await adminPost({ claude: "vercel" });
  assert.equal(sw.status, 200);
  assert.equal(sw.json.settings.claude, "vercel");
  const old = await inflight;
  assert.equal(old.status, 200);
  assert.ok(old.text.includes('"model":"c4r/claude-slow"') && old.text.includes("done"), "in-flight stream completed on 4router");
  await msg(K.claude, "claude-haiku-5-5");
  assert.equal(last().model, "cvc/claude-haiku-5-5");
  assert.equal((await adminPost({ codexDisabled: ["gpt-6-luna"] })).status, 200);
  const off = await call("POST", "/v1/responses", { authorization: `Bearer ${K.codex}` }, { model: "gpt-6-luna" });
  assert.equal(off.status, 403);
  assert.match(off.json.error.message, /disabled/);
  const list = await call("GET", "/v1/models", { authorization: `Bearer ${K.legacy}` });
  assert.deepEqual(list.json.data.map((m: any) => m.id), ["claude-haiku-5-5", "gpt-6-sol"]);
});

test("settings survive a restart", async () => {
  await stopFront();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { claude: "vercel", gemini: "4router", codexDisabled: ["gpt-6-luna"] });
  await startFront();
  await msg(K.legacy, "claude-haiku-5-5");
  assert.equal(last().model, "cvc/claude-haiku-5-5");
  assert.equal((await call("POST", "/v1/responses", { authorization: `Bearer ${K.legacy}` }, { model: "gpt-6-luna" })).status, 403);
});
