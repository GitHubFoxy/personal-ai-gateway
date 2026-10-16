import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { platform } from "node:os";
import { loadConfig, loadSecrets, saveJson, configPath, secretsPath, type Secrets } from "./config.ts";

const authOrigin = "https://auth.openai.com";
const api = "https://api.openai.com/v1";
const tokenEndpoint = authOrigin + "/api/accounts/oauth/token";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export type OAuthRegistration = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  subject: string;
  scope: string;
};
type TokenResult = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};
function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === "object" && !Array.isArray(x); }
function fromB64(s: string): Buffer { return Buffer.from(s, "base64url"); }
export function verifiedIdentity(jwt: string, clientId: string, nonce: string, jwks: unknown): string {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid OIDC ID token");
  const hdr: unknown = JSON.parse(fromB64(parts[0]).toString("utf8"));
  const claims: unknown = JSON.parse(fromB64(parts[1]).toString("utf8"));
  if (!record(hdr) || !record(claims) || (hdr.alg !== "RS256" && hdr.alg !== "ES256")) throw new Error("Unsupported ID-token signature algorithm");
  if (!record(jwks) || !Array.isArray(jwks.keys)) throw new Error("Invalid OpenAI JWKS");
  const keyData = jwks.keys.find(k => record(k) && k.kid === hdr.kid && (!k.alg || k.alg === hdr.alg));
  if (!keyData) throw new Error("ID-token signing key not found");
  const key = createPublicKey({ key: keyData, format: "jwk" });
  const valid = verify(hdr.alg === "RS256" ? "RSA-SHA256" : "sha256",
    Buffer.from(parts[0] + "." + parts[1]),
    hdr.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, fromB64(parts[2]));
  if (!valid) throw new Error("OpenAI ID-token signature validation failed");
  if (claims.iss !== authOrigin) throw new Error("OpenAI ID-token issuer mismatch");
  const audiences = typeof claims.aud === "string" ? [claims.aud] :
    Array.isArray(claims.aud) && claims.aud.every(a => typeof a === "string") ? claims.aud : [];
  if (!audiences.includes(clientId) || (claims.azp !== undefined && claims.azp !== clientId))
    throw new Error("OpenAI ID-token audience mismatch");
  if (claims.nonce !== nonce) throw new Error("OpenAI ID-token nonce mismatch");
  if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 || typeof claims.iat !== "number")
    throw new Error("OpenAI ID-token is expired or missing a valid issue time");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("OpenAI ID-token is missing a subject");
  return claims.sub;
}
async function exchange(data: Record<string, string>, fetcher: typeof fetch): Promise<TokenResult> {
  const response = await fetcher(tokenEndpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data), redirect: "error", signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error("OpenAI OAuth token exchange failed (HTTP " + response.status + ")");
  const token = await response.json() as TokenResult;
  if (!token.access_token || !token.refresh_token || !token.scope || token.token_type?.toLowerCase() !== "bearer")
    throw new Error("OpenAI OAuth returned incomplete credentials");
  if (!token.scope.split(" ").includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage permission was not granted");
  return token;
}
function openBrowser(url: string): boolean {
  const os = platform();
  const program = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  try { const process = spawn(program, args, { detached: true, stdio: "ignore" }); process.on("error", () => {}); process.unref(); return true; }
  catch { return false; }
}
export async function loginChatGPT(accountId = "chatgpt", fetcher: typeof fetch = fetch): Promise<void> {
  const secrets = loadSecrets();
  const old = secrets.oauth?.[accountId];
  const hostId = secrets.hostId ?? "urn:uuid:" + randomUUID();
  if (!secrets.hostId) { secrets.hostId = hostId; saveJson(secretsPath(), secrets); }
  const nonce = randomBytes(24).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let complete!: (value: { code: string; clientId: string }) => void;
  let failed!: (error: Error) => void;
  const result = new Promise<{ code: string; clientId: string }>((resolve, reject) => { complete = resolve; failed = reject; });
  const listener = createServer((req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/auth/callback") { res.writeHead(404); res.end(); return; }
      if (u.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
      if (u.searchParams.has("error")) throw new Error("OpenAI authorization declined");
      const code = u.searchParams.get("code"), clientId = old?.clientId ?? u.searchParams.get("client_id");
      if (!code || !clientId || clientId === "dynamic_agent_client") throw new Error("Missing OAuth code or issued client ID");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("Personal AI Gateway: authorization received. You may close this tab.");
      complete({ code, clientId });
    } catch (e) {
      res.writeHead(400, { "content-type": "text/plain" }); res.end("OAuth authorization failed");
      failed(e as Error);
    }
  });
  listener.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const addr = listener.address();
  if (!addr || typeof addr === "string") throw new Error("Could not establish loopback callback");
  const redirectUri = "http://127.0.0.1:" + addr.port + "/auth/callback";
  const params = new URLSearchParams({
    client_id: old?.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId, redirect_uri: redirectUri, response_type: "code",
    scope: scopes, resource: api, state, nonce, code_challenge_method: "S256", code_challenge: challenge,
    ...(!old ? { agent_name_hint: "Personal AI Gateway" } : {})
  });
  const url = authOrigin + "/api/accounts/authorize?" + params;
  const timer = setTimeout(() => failed(new Error("ChatGPT login timed out")), 180_000);
  try {
    console.log("Open this URL in a browser on the SAME machine to authorize PAG:\n" + url);
    openBrowser(url);
    const { code, clientId } = await result;
    const token = await exchange({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: api }, fetcher);
    if (!token.id_token) throw new Error("No ID token returned by OpenAI");
    const jwksResponse = await fetcher(authOrigin + "/.well-known/jwks.json", { signal: AbortSignal.timeout(20_000) });
    if (!jwksResponse.ok) throw new Error("Failed fetching OpenAI signing keys");
    const sub = verifiedIdentity(token.id_token, clientId, nonce, await jwksResponse.json());
    if (old?.subject && old.subject !== sub) throw new Error("Sign-in account does not match existing registration");
    const newest = loadSecrets();
    newest.oauth ??= {};
    newest.oauth[accountId] = {
      clientId, accessToken: token.access_token!, refreshToken: token.refresh_token!,
      idToken: token.id_token, expiresAt: Date.now() + 1000 * (token.expires_in ?? 3600),
      subject: sub, scope: token.scope!
    };
    saveJson(secretsPath(), newest);
    const cfg = loadConfig();
    cfg.accounts[accountId] = { kind: "llm", baseUrl: api, auth: "chatgpt-oauth" };
    saveJson(configPath(), cfg);
    console.log("ChatGPT plan account authorized as " + accountId + ". Use Responses API only (store:false, stream:true).");
  } finally {
    clearTimeout(timer);
    listener.close();
  }
}
const pending = new Map<string, Promise<string>>();
async function refresh(account: string, oauth: OAuthRegistration, fetcher: typeof fetch): Promise<string> {
  const token = await exchange({ grant_type: "refresh_token", client_id: oauth.clientId, refresh_token: oauth.refreshToken, resource: api }, fetcher);
  const newest = loadSecrets();
  if (!newest.oauth?.[account]) throw new Error("OAuth account removed");
  newest.oauth[account] = { ...oauth, accessToken: token.access_token!, refreshToken: token.refresh_token!,
    expiresAt: Date.now() + 1000 * (token.expires_in ?? 3600), scope: token.scope! };
  saveJson(secretsPath(), newest);
  return token.access_token!;
}
export async function getOAuthToken(account: string, secrets: Secrets, fetcher: typeof fetch = fetch): Promise<string> {
  const record = secrets.oauth?.[account];
  if (!record) throw new Error("ChatGPT OAuth sign-in required");
  if (record.expiresAt > Date.now() + 120_000) return record.accessToken;
  const existing = pending.get(account);
  if (existing) return existing;
  const promise = refresh(account, record, fetcher);
  pending.set(account, promise);
  try { return await promise; } finally { pending.delete(account); }
}
