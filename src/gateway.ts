import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfig, loadSecrets, verifyKey, checkEndpoint, type Account, type Alias, type Config, type Endpoint, type Target } from "./config.ts";
import { canTranslate, normalizeDecisions, parseDecision, toProviderDecision } from "./decisions.ts";
import { getOAuthToken } from "./siwc.ts";
import { chatRequest, chatResponse } from "./chatgpt-chat.ts";

type Fetcher = typeof fetch;
const retryable = new Set([429, 500, 502, 503, 504]);
const cooldown = new Map<string, number>();
const maxBodyBytes = 2 * 1024 * 1024;
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function error(res: ServerResponse, code: number, message: string, id: string): void {
  json(res, code, { error: { code: code === 504 ? "timeout" : code === 429 ? "rate_limit" : code === 401 ? "unauthorized" : code === 503 ? "unavailable" : code === 502 ? "upstream_error" : "bad_request", message, request_id: id } });
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > maxBodyBytes) {
    req.resume(); // Drain oversized request instead of destroying the connection.
    const err = new Error("Request body exceeds 2 MiB") as Error & { status?: number };
    err.status = 413;
    throw err;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBodyBytes) { const e = new Error("Request body exceeds 2 MiB"); (e as Error & { status?: number }).status = 413; throw e; }
    chunks.push(buf);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value as Record<string, unknown>;
}
function endpointFor(account: Account, endpoint: Endpoint): string | undefined {
  return account.endpoints?.[endpoint] || (account.baseUrl ? account.baseUrl.replace(/\/$/, "") + "/" + (endpoint === "chat" ? "chat/completions" : endpoint) : undefined);
}
function validRoute(cfg: Config, alias: Alias, endpoint: Endpoint, target: Target): boolean {
  const a = cfg.accounts[target.account];
  if (!a || a.kind !== alias.type || (!cfg.fallback.allowPaid && a.paid)) return false;
  if (a.auth === "chatgpt-oauth" && endpoint === "decisions") return false;
  const url = endpointFor(a, a.auth === "chatgpt-oauth" && endpoint === "chat" ? "responses" : endpoint);
  if (!url) return false;
  try { checkEndpoint(url); } catch { return false; }
  return true;
}
function selectedTargets(cfg: Config, alias: Alias, endpoint: Endpoint): Target[] {
  const available = alias.targets.filter(t => validRoute(cfg, alias, endpoint, t));
  return (!cfg.fallback.enabled || alias.fallback === false) ? available.slice(0, 1) : available;
}
function requestHeaders(account: Account, token: string, input: IncomingMessage, body: Record<string, unknown>, key: string): Headers {
  const headers = new Headers({ "authorization": "Bearer " + token, "content-type": "application/json", "user-agent": "personal-ai-gateway/0.1" });
  if (account.session === "opencode") {
    const source = input.headers["x-opencode-session"];
    const raw = Array.isArray(source) ? source[0] : source;
    const user = typeof body.user === "string" ? body.user : "default";
    const derived = createHash("sha256").update(key + ":" + user).digest("hex").slice(0, 32);
    headers.set("x-opencode-session", raw && /^[\w.-]{1,128}$/.test(raw) ? raw : "pag-" + derived);
  }
  return headers;
}
function signalWithDeadline(req: IncomingMessage, res: ServerResponse, timeout: number): { signal: AbortSignal; cleanup: () => void; expired: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const close = () => { if (!res.writableEnded) controller.abort(); };
  req.on("aborted", close);
  res.on("close", close);
  return { signal: controller.signal, expired: () => timedOut, cleanup: () => { clearTimeout(timer); req.off("aborted", close); res.off("close", close); } };
}
export function createGateway(options: { fetcher?: Fetcher; config?: () => Config; secrets?: () => { gatewayKey: string; accounts: Record<string, string> } } = {}): Server {
  const fetcher = options.fetcher ?? fetch;
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("access-control-allow-origin", "null");
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
    let cfg: Config;
    let secrets: { gatewayKey: string; accounts: Record<string, string> };
    try { cfg = (options.config ?? loadConfig)(); secrets = (options.secrets ?? loadSecrets)(); }
    catch { return error(res, 503, "Gateway not initialized; run pag init", requestId); }
    if (req.method === "GET" && path === "/readyz") return json(res, 200, { ready: true });
    if (!verifyKey(req.headers.authorization, secrets.gatewayKey)) return error(res, 401, "Invalid gateway token", requestId);
    if (req.method === "GET" && path === "/v1/models") {
      return json(res, 200, { object: "list", data: Object.entries(cfg.routes).map(([id, route]) => ({ id, object: "model", owned_by: "pag", type: route.type })) });
    }
    const endpoint: Endpoint | undefined = req.method !== "POST" ? undefined :
      path === "/v1/responses" ? "responses" : path === "/v1/chat/completions" ? "chat" : path === "/v1/decisions" ? "decisions" : undefined;
    if (!endpoint) return error(res, 404, "Unknown endpoint", requestId);
    let body: Record<string, unknown>;
    try { body = await readBody(req); }
    catch (e) { return error(res, (e as { status?: number }).status ?? 400, "Invalid JSON or request body", requestId); }
    const aliasName = String(body.model ?? (endpoint === "decisions" ? "decision" : "coding"));
    const alias = cfg.routes[aliasName];
    const family = endpoint === "decisions" ? "decisions" : "llm";
    if (!alias || alias.type !== family) return error(res, 422, "Unknown or incompatible model alias", requestId);
    let decisions: ReturnType<typeof parseDecision> | undefined;
    if (endpoint === "decisions") {
      try { decisions = parseDecision(body); } catch (e) { return error(res, 422, (e as Error).message, requestId); }
    }
    const targets = selectedTargets(cfg, alias, endpoint);
    if (!targets.length) return error(res, 503, "No compatible configured upstream routes", requestId);
    const limit = Math.min(Math.max(Number(cfg.fallback.timeoutMs) || 30000, 1000), 120000);
    const run = signalWithDeadline(req, res, limit);
    let lastStatus = 502;
    try {
      let attempts = 0;
      let unsupportedChat = false;
      for (const target of targets) {
        if (attempts >= Math.min(Math.max(cfg.fallback.maxAttempts || 1, 1), 10) || run.signal.aborted) break;
        const routeId = target.account + ":" + target.model + ":" + endpoint;
        if ((cooldown.get(routeId) ?? 0) > Date.now()) continue;
        const account = cfg.accounts[target.account];
        const convertedChat = endpoint === "chat" && account.auth === "chatgpt-oauth" ? chatRequest(body, target.model) : undefined;
        if (endpoint === "chat" && account.auth === "chatgpt-oauth" && !convertedChat) { unsupportedChat = true; continue; }
        if (endpoint === "decisions" && !canTranslate(decisions!, account.protocol ?? "systemone")) continue;
        let token = secrets.accounts[target.account];
        if (account.auth === "chatgpt-oauth") {
          // Official ChatGPT subscription grants only support streamed, unstored Responses.
          if (!convertedChat && (endpoint !== "responses" || body.stream !== true || body.store === true)) continue;
          try { token = await getOAuthToken(target.account, secrets, fetcher); }
          catch { lastStatus = 503; continue; }
        }
        if (!token) continue;
        const url = endpointFor(account, convertedChat ? "responses" : endpoint)!;
        attempts++;
        let response: Response;
        try {
          const outbound = convertedChat ?? (endpoint === "decisions" ? toProviderDecision(decisions!, target.model, account.protocol ?? "systemone") :
            account.auth === "chatgpt-oauth" ? { ...body, ...(typeof body.input === "string" ? { input: [{ role: "user", content: body.input }] } : {}), model: target.model, store: false, stream: true } : { ...body, model: target.model });
          response = await fetcher(url, {
            method: "POST",
            headers: requestHeaders(account, token, req, body, secrets.gatewayKey),
            body: JSON.stringify(outbound),
            signal: run.signal,
            redirect: "error"
          });
        } catch {
          if (run.expired()) { lastStatus = 504; break; }
          if (run.signal.aborted) return;
          cooldown.set(routeId, Date.now() + Math.min(cfg.fallback.cooldownMs || 60000, 600000));
          continue;
        }
        if (!response.ok) {
          lastStatus = retryable.has(response.status) ? 503 : 502;
          if (!retryable.has(response.status)) return error(res, 502, "Upstream provider rejected request", requestId);
          const retryAfter = Number(response.headers.get("retry-after"));
          const cooldownMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 600000) : cfg.fallback.cooldownMs || 60000;
          cooldown.set(routeId, Date.now() + cooldownMs);
          await response.body?.cancel();
          continue;
        }
        if (endpoint !== "decisions" && body.stream === true) {
          if (!response.body) { lastStatus = 502; continue; }
          const reader = response.body.getReader();
          const first: Uint8Array[] = [];
          let prefix = "";
          let prematureFailure = false;
          try {
            // Some subscription quotas return HTTP 200 followed by response.failed in SSE.
            // Withhold *initial* control events until we can identify an early failure.
            for (let i = 0; i < 8; i++) {
              const event = await reader.read();
              if (event.done) break;
              first.push(event.value);
              prefix += new TextDecoder().decode(event.value);
              if (/response\.failed|subscription_sharing_usage_limit_exceeded|subscription_sharing_usage_unavailable/.test(prefix)
                  && !/response\.output_text\.delta|response\.output_item\.added/.test(prefix)) {
                prematureFailure = true; break;
              }
              if (/response\.output_text\.delta|response\.output_item\.added|response\.completed|"choices"\s*:|\[DONE\]/.test(prefix)
                  || prefix.length > 16384) break;
            }
          } catch { if (run.expired()) lastStatus = 504; else lastStatus = 502; continue; }
          if (prematureFailure) {
            cooldown.set(routeId, Date.now() + Math.min(cfg.fallback.cooldownMs || 60000, 600000));
            await reader.cancel().catch(() => {});
            lastStatus = 503;
            continue;
          }
          if (!first.length) { lastStatus = 502; continue; }
          res.writeHead(200, {
            "content-type": response.headers.get("content-type") || "text/event-stream",
            "cache-control": "no-cache",
            "x-pag-provider": target.account,
            "x-pag-model": target.model
          });
          const write = async (chunk: Uint8Array): Promise<void> => {
            if (!res.write(chunk)) await new Promise<void>(resolve => {
              const finish = () => { res.off("drain", finish); res.off("close", finish); resolve(); };
              res.once("drain", finish);
              res.once("close", finish);
            });
          };
          try {
            for (const chunk of first) await write(chunk);
            while (!run.signal.aborted) {
              const next = await reader.read();
              if (next.done) break;
              await write(next.value);
            }
          } catch { /* Midstream failures cannot be safely replayed to another provider. */ }
          finally { reader.releaseLock(); }
          if (!res.writableEnded) res.end();
          return;
        }
        try {
          const data: unknown = convertedChat ? await chatResponse(response, aliasName) : await response.json();
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid upstream JSON");
          const output: Record<string, unknown> = endpoint === "decisions" ?
            normalizeDecisions(data, decisions!, aliasName) : { ...data as Record<string, unknown>, model: aliasName };
          res.setHeader("x-pag-provider", target.account);
          res.setHeader("x-pag-model", target.model);
          return json(res, 200, output);
        } catch {
          lastStatus = 502;
          cooldown.set(routeId, Date.now() + Math.min(cfg.fallback.cooldownMs || 60000, 600000));
        }
      }
      if (run.signal.aborted && !run.expired()) return;
      return error(res, run.expired() ? 504 : unsupportedChat && !attempts ? 422 : lastStatus, run.expired() ? "Gateway deadline exceeded" : unsupportedChat && !attempts ? "ChatGPT OAuth supports only non-streaming text chat requests with supported options" : "No upstream route completed successfully", requestId);
    } finally { run.cleanup(); }
  });
}
export function startGateway(): void {
  const cfg = loadConfig();
  const server = createGateway();
  server.listen(Number(process.env.PAG_PORT ?? cfg.port), process.env.PAG_HOST ?? cfg.host, () => {
    console.log("PAG listening on http://" + (process.env.PAG_HOST ?? cfg.host) + ":" + (process.env.PAG_PORT ?? cfg.port));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
