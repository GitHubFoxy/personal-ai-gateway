/**
 * PAG front: sits in front of CLIProxyAPI, records every POST to ClickHouse,
 * and serves /v1/decisions itself (CLIProxyAPI has no Decisions API).
 * Config: JSON file from $PAG_FRONT_CONFIG (see config.example.json).
 */
import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { canTranslate, normalizeDecisions, parseDecision, toProviderDecision } from "./decisions.ts";
import { redactHeaders, sessionId } from "./capture.ts";
import { filterModelList, givenKey, plan, resolveKey, type ClientKey, type Prefixes, type Scope, type Settings } from "./routing.ts";
import { loadSettings, saveSettings, validateSettings } from "./settings.ts";
import { handleAdmin, type AdminCfg } from "./admin.ts";
import { queryLogs, type LogQuery } from "./logs.ts";

type Route = { name: string; protocol: "systemone" | "openai"; url: string; keyFile: string; model: string; omitModel?: boolean; enabled?: boolean };
type Config = {
  listen: { host: string; port: number };
  upstream: string;
  clientKeyFile: string;
  /** Extra client keys limited to one model family; clientKeyFile stays the full-access key. */
  clientKeys?: { name: string; scope: Scope; file: string }[];
  /** Provider name -> CLIProxyAPI credential prefix. The first provider is the default. */
  providers: Prefixes;
  settingsFile: string;
  admin: AdminCfg;
  clickhouse: { url: string; user: string; passFile: string; readUser?: string; readPassFile?: string };
  decisions: { alias: string; routes: Route[] };
};

const cfg: Config = JSON.parse(readFileSync(process.env.PAG_FRONT_CONFIG ?? "config.json", "utf8"));
const secret = (f: string) => readFileSync(f, "utf8").trim();
const clientKey = Buffer.from(secret(cfg.clientKeyFile));
const chPass = secret(cfg.clickhouse.passFile);
const clientKeys: ClientKey[] = [
  { name: "legacy", scope: "all", key: clientKey },
  ...(cfg.clientKeys ?? []).map(k => ({ name: k.name, scope: k.scope, key: Buffer.from(secret(k.file)) })),
];
for (const k of clientKeys) {
  if (!["all", "claude", "gemini", "codex"].includes(k.scope)) throw new Error(`client key ${k.name}: bad scope ${k.scope}`);
  if (k.key.length < 32) throw new Error(`client key ${k.name} is too short`);
  if (clientKeys.some(o => o !== k && o.key.equals(k.key))) throw new Error(`client key ${k.name} duplicates another key`);
}
let settings: Settings = loadSettings(cfg.settingsFile, cfg.providers);
console.log("provider settings:", JSON.stringify(settings));
const csrf = randomBytes(32).toString("base64url");
const adminCtx = {
  cfg: cfg.admin, csrf, prefixes: cfg.providers,
  keys: [{ name: "legacy", scope: "all", file: cfg.clientKeyFile }, ...(cfg.clientKeys ?? []).map(k => ({ name: k.name, scope: k.scope, file: k.file }))],
  getSettings: () => settings,
  async listLogs(query: LogQuery) {
    if (!cfg.clickhouse.readUser || !cfg.clickhouse.readPassFile) throw new Error("ClickHouse read access is not configured");
    return queryLogs({ url: cfg.clickhouse.url, user: cfg.clickhouse.readUser, password: secret(cfg.clickhouse.readPassFile) }, query);
  },
  update(patch: Record<string, unknown>, who: string): Settings {
    const next = validateSettings({ ...settings, ...patch }, cfg.providers);
    saveSettings(cfg.settingsFile, next);
    console.log(`provider settings changed by ${who}: ${JSON.stringify(settings)} -> ${JSON.stringify(next)}`);
    return (settings = next);
  },
  async listModels() {
    const r = await fetch(new URL("/v1/models", upstream), { headers: { authorization: `Bearer ${clientKey.toString()}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`CLIProxyAPI /v1/models HTTP ${r.status}`);
    return ((await r.json()) as { data: { id: string; owned_by?: string }[] }).data;
  },
};
const routes = cfg.decisions.routes.filter(r => r.enabled !== false).map(r => ({ ...r, key: secret(r.keyFile) }));
const upstream = new URL(cfg.upstream);
const BODY_CAP = 32 * 1024 * 1024; // stored per body; forwarding is never truncated
const QUEUE_CAP = 2000;

type Row = Record<string, string | number>;
const queue: Row[] = [];

async function flush(): Promise<void> {
  if (!queue.length) return;
  const batch = queue.splice(0);
  try {
    const q = encodeURIComponent("INSERT INTO pag.requests FORMAT JSONEachRow");
    const r = await fetch(`${cfg.clickhouse.url}/?query=${q}&date_time_input_format=best_effort`, {
      method: "POST",
      headers: { "X-ClickHouse-User": cfg.clickhouse.user, "X-ClickHouse-Key": chPass },
      body: batch.map(x => JSON.stringify(x)).join("\n"),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  } catch (e) {
    console.error("clickhouse insert failed:", (e as Error).message);
    queue.unshift(...batch);
    if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP); // drop oldest
  }
}
setInterval(flush, 2000).unref();

const cap = (b: Buffer): [string, number] => b.length > BODY_CAP ? [b.subarray(0, BODY_CAP).toString("utf8"), 1] : [b.toString("utf8"), 0];
const jsonOrUndefined = (b: Buffer): any => { try { return JSON.parse(b.toString("utf8")); } catch { return undefined; } };

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: http.IncomingMessage): boolean {
  const h = req.headers;
  const given = typeof h["x-api-key"] === "string" ? h["x-api-key"] : String(h.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  return a.length === clientKey.length && timingSafeEqual(a, clientKey);
}

function send(res: http.ServerResponse, status: number, body: unknown): string {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
  return text;
}

let rr = 0;
async function decisions(req: http.IncomingMessage, res: http.ServerResponse, base: Row, reqBody: Buffer) {
  const start = Date.now();
  const done = (status: number, body: unknown, upstreamName = "", error = "") => {
    const text = send(res, status, body);
    queue.push({ ...base, status, duration_ms: Date.now() - start, upstream: upstreamName, error, res_body: text, res_headers: "{}" });
  };
  if (!authorized(req)) return done(401, { error: "invalid key" });
  const body = jsonOrUndefined(reqBody);
  if (!body || typeof body !== "object") return done(400, { error: "invalid JSON" });
  let dec;
  try { dec = parseDecision(body); } catch (e) { return done(422, { error: (e as Error).message }); }
  const alias = String(body.model ?? cfg.decisions.alias);
  const errors: string[] = [];
  const first = rr++;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[(first + i) % routes.length];
    if (!canTranslate(dec, r.protocol)) continue;
    try {
      const out = toProviderDecision(dec, r.model, r.protocol);
      if (r.omitModel) delete out.model;
      const up = await fetch(r.url, {
        method: "POST",
        headers: { authorization: `Bearer ${r.key}`, "content-type": "application/json" },
        body: JSON.stringify(out),
        signal: AbortSignal.timeout(30_000),
      });
      if (!up.ok) throw new Error(`HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
      return done(200, normalizeDecisions(await up.json(), dec, alias), r.name);
    } catch (e) {
      errors.push(`${r.name}: ${(e as Error).message}`);
    }
  }
  done(502, { error: "all decision routes failed", details: errors }, "", errors.join(" | "));
}

type Forward = { path: string; headers: http.OutgoingHttpHeaders; filterList: boolean };

/** Send the request on with CLIProxyAPI's key; the client's own key never leaves PAG. */
function forwardFor(req: http.IncomingMessage, path: string, query: URLSearchParams): Forward {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, authorization: `Bearer ${clientKey.toString()}` };
  delete headers["x-api-key"]; delete headers["x-goog-api-key"];
  const q = new URLSearchParams(query); q.delete("key");
  const qs = q.toString();
  return { path: path + (qs ? "?" + qs : ""), headers, filterList: req.method === "GET" && (path === "/v1/models" || path === "/v1beta/models") };
}

function apiError(res: http.ServerResponse, status: number, message: string): string {
  const type = status === 403 ? "permission_error" : status === 401 ? "authentication_error" : "invalid_request_error";
  return send(res, status, { type: "error", error: { type, code: status, message } });
}

async function proxy(req: http.IncomingMessage, res: http.ServerResponse, base: Row, reqBody: Buffer, log: boolean, fwd?: Forward) {
  const start = Date.now();
  let ttft = 0, finished = false;
  const out: Buffer[] = [];
  let outSize = 0;
  const finish = (status: number, resHeaders: string, error = "") => {
    if (finished) return;
    finished = true;
    if (!log) return;
    const [res_body, t2] = cap(Buffer.concat(out));
    queue.push({ ...base, status, duration_ms: Date.now() - start, ttft_ms: ttft, error, res_headers: resHeaders, res_body, truncated: (base.truncated as number) | t2 | (outSize > BODY_CAP ? 1 : 0) });
  };
  const headers: http.OutgoingHttpHeaders = fwd ? { ...fwd.headers } : { ...req.headers };
  delete headers.host;
  delete headers["accept-encoding"]; // keep upstream bodies readable in the log
  headers["content-length"] = String(reqBody.length);
  delete headers["transfer-encoding"];
  const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: fwd?.path ?? req.url, headers }, ures => {
    const h = { ...ures.headers };
    delete h.connection; delete h["keep-alive"];
    if (fwd?.filterList && ures.statusCode === 200 && String(h["content-type"] ?? "").includes("json")) {
      const parts: Buffer[] = [];
      ures.on("data", (c: Buffer) => parts.push(c));
      ures.on("end", () => {
        let text = Buffer.concat(parts).toString("utf8");
        try { text = JSON.stringify(filterModelList(JSON.parse(text), settings, cfg.providers)); } catch { /* pass through as-is */ }
        delete h["content-length"]; delete h["transfer-encoding"];
        res.writeHead(200, h).end(text);
        ttft = Date.now() - start; out.push(Buffer.from(text));
        finish(200, redactHeaders(ures.headers));
      });
      ures.on("error", e => { res.destroy(); finish(502, "{}", e.message); });
      return;
    }
    res.writeHead(ures.statusCode ?? 502, h);
    ures.on("data", (c: Buffer) => {
      if (!ttft) ttft = Date.now() - start;
      if (outSize < BODY_CAP) out.push(c);
      outSize += c.length;
    });
    ures.on("end", () => finish(ures.statusCode ?? 502, redactHeaders(ures.headers)));
    ures.on("error", e => finish(502, "{}", e.message));
    ures.pipe(res);
  });
  up.on("error", e => {
    if (!res.headersSent) send(res, 502, { error: "upstream unreachable: " + e.message }); else res.destroy();
    finish(502, "{}", e.message);
  });
  res.on("close", () => { if (!finished) { up.destroy(); finish(499, "{}", "client closed"); } });
  up.end(reqBody);
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/healthz") return void res.end("ok");
  try {
    if (await handleAdmin(req, res, path, adminCtx)) return;
  } catch (e) {
    console.error("admin error:", (e as Error).message);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
    return;
  }
  const post = req.method === "POST";
  let reqBody: Buffer;
  try { reqBody = await readBody(req); } catch { return void res.destroy(); }
  const parsed = post ? jsonOrUndefined(reqBody) : undefined;
  const [req_body, truncated] = cap(reqBody);
  const base: Row = {
    ts: new Date().toISOString(), id: randomUUID(), kind: path === "/v1/decisions" ? "decisions" : "proxy",
    method: req.method ?? "", path, status: 0, duration_ms: 0, ttft_ms: 0,
    client_ip: req.socket.remoteAddress ?? "", user_agent: String(req.headers["user-agent"] ?? ""),
    session_id: sessionId(req.headers, parsed), model: String(parsed?.model ?? ""), stream: parsed?.stream === true ? 1 : 0,
    upstream: "", error: "", truncated, req_headers: redactHeaders(req.headers), req_body, res_headers: "{}", res_body: "",
  };
  if (post && path === "/v1/decisions") return decisions(req, res, base, reqBody);
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const key = resolveKey(givenKey(req.headers, query), clientKeys);
  // Unknown or missing key: forward untouched, CLIProxyAPI answers as before (401, management panel).
  if (!key) return proxy(req, res, base, reqBody, post);
  const p = plan({ method: req.method ?? "", path, body: parsed, scope: key.scope, settings, prefixes: cfg.providers });
  base.model = p.model;
  base.req_headers = JSON.stringify({ ...JSON.parse(base.req_headers as string), "x-pag-key": key.name });
  if (!p.ok) {
    const text = apiError(res, p.status, p.error);
    if (post) queue.push({ ...base, status: p.status, error: p.error, res_body: text });
    return;
  }
  base.upstream = p.provider;
  const fwd = forwardFor(req, p.path, query);
  return proxy(req, res, base, p.body ? Buffer.from(JSON.stringify(p.body)) : reqBody, post, fwd);
});
server.requestTimeout = 0;
server.timeout = 0;
server.listen(cfg.listen.port, cfg.listen.host, () => {
  const a = server.address();
  console.log(`pag-front on ${cfg.listen.host}:${typeof a === "object" && a ? a.port : cfg.listen.port} -> ${cfg.upstream}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); flush().finally(() => process.exit(0)); });
