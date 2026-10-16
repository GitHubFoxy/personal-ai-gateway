import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Family = "llm" | "decisions";
export type Endpoint = "responses" | "chat" | "decisions";
export type Account = {
  kind: Family;
  baseUrl: string;
  protocol?: "systemone";
  endpoints?: Partial<Record<Endpoint, string>>;
  paid?: boolean;
  session?: "opencode";
  auth?: "chatgpt-oauth";
};
export type Target = { account: string; model: string };
export type Alias = { type: Family; targets: Target[]; fallback?: boolean };
export type Config = {
  host: string;
  port: number;
  accounts: Record<string, Account>;
  routes: Record<string, Alias>;
  fallback: { enabled: boolean; maxAttempts: number; cooldownMs: number; timeoutMs: number; allowPaid: boolean };
};
export type OAuthCredentials = {
  clientId: string; accessToken: string; refreshToken: string;
  idToken: string; expiresAt: number; subject: string; scope: string;
};
export type Secrets = {
  gatewayKey: string; accounts: Record<string, string>;
  oauth?: Record<string, OAuthCredentials>; hostId?: string;
};

export const home = () => process.env.PAG_HOME || join(homedir(), ".config", "pag");
export const configPath = () => join(home(), "config.json");
export const secretsPath = () => join(home(), "secrets.json");
export const defaultConfig = (): Config => ({
  host: "127.0.0.1", port: 4000, accounts: {}, routes: {},
  fallback: { enabled: true, maxAttempts: 3, cooldownMs: 60_000, timeoutMs: 30_000, allowPaid: true }
});
const fileMode = 0o600;
export function saveJson(path: string, object: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomBytes(6).toString("hex") + ".tmp";
  writeFileSync(temp, JSON.stringify(object, null, 2) + "\n", { mode: fileMode });
  chmodSync(temp, fileMode);
  renameSync(temp, path);
}
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function createKey(): string { return "pag_" + randomBytes(32).toString("base64url"); }
export function initialize(): { created: boolean; key?: string } {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  if (existsSync(configPath()) || existsSync(secretsPath())) {
    if (!existsSync(configPath()) || !existsSync(secretsPath())) throw new Error("Incomplete PAG configuration; repair it manually.");
    return { created: false };
  }
  const key = createKey();
  saveJson(configPath(), defaultConfig());
  saveJson(secretsPath(), { gatewayKey: key, accounts: {} } satisfies Secrets);
  return { created: true, key };
}
export function loadConfig(): Config {
  const cfg = readJson<Config>(configPath());
  if (!cfg || !cfg.accounts || !cfg.routes || !cfg.fallback) throw new Error("Invalid PAG configuration");
  return cfg;
}
export function loadSecrets(): Secrets {
  const s = readJson<Secrets>(secretsPath());
  if (!s.gatewayKey || !s.accounts) throw new Error("Invalid PAG secrets");
  return s;
}
export function verifyKey(actual: string | undefined, expected: string): boolean {
  if (!actual || !actual.startsWith("Bearer ")) return false;
  const a = Buffer.from(actual.slice(7)), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function checkEndpoint(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(u.hostname))) {
    throw new Error("Provider endpoints must use HTTPS (HTTP only for localhost tests)");
  }
  if (u.username || u.password || u.hash) throw new Error("Provider URL cannot contain credentials or fragments");
}
