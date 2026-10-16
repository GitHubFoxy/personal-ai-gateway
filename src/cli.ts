#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync, existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { checkEndpoint, configPath, home, initialize, loadConfig, loadSecrets, saveJson, secretsPath, type Account, type Config, type Family, type Target } from "./config.ts";
import { startGateway } from "./gateway.ts";
import { loginChatGPT, getOAuthToken } from "./siwc.ts";

const [command, ...args] = process.argv.slice(2);
const help = `Personal AI Gateway (PAG)

  pag init
  pag serve
  pag auth add gemini                 (paste API key, then press Enter)
  pag auth add vercel                 (Vercel AI Gateway)
  pag auth add vercel-decisions --kind decisions (Vercel Decisions API)
  pag auth add NAME --kind llm|decisions --base-url URL [--decisions-url URL] [--protocol systemone|openai] [--session opencode] [--paid] [--key-stdin]
  pag auth models ACCOUNT          (list provider models, when supported)
  pag auth list
  pag auth remove NAME
  pag auth login openai           (official ChatGPT open-source OAuth flow)
  pag route set ALIAS llm|decisions ACCOUNT:MODEL [ACCOUNT:MODEL...]
  pag route promote ALIAS ACCOUNT:MODEL
  pag route fallback ALIAS on|off
  pag route list
  pag route show ALIAS
  pag status
  pag doctor

Use PAG_HOME to choose a configuration directory. Credentials stored separately with mode 0600.
`;
function requireArg(value: string | undefined, message: string): string { if (!value) throw new Error(message); return value; }
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
async function readKey(provider = "Provider"): Promise<string> {
  if (args.includes("--key-stdin")) {
    const value = readFileSync(0, "utf8").trim();
    if (!value) throw new Error("Empty upstream key on stdin");
    return value;
  }
  if (!stdin.isTTY) throw new Error("Use --key-stdin to supply upstream key via pipe");
  stdout.write(provider + " API key (paste, input hidden): ");
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else if (!value.trim()) reject(new Error("Empty upstream key"));
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") return finish(new Error("Key entry cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}
function writeConfig(config: Config): void { saveJson(configPath(), config); }
function parseTarget(s: string): Target {
  const pos = s.indexOf(":");
  if (pos < 1 || pos === s.length - 1) throw new Error("Expected ACCOUNT:MODEL");
  return { account: s.slice(0, pos), model: s.slice(pos + 1) };
}
async function main() {
  if (!command || ["-h", "--help", "help"].includes(command)) { console.log(help); return; }
  if (command === "init") {
    const init = initialize();
    console.log(init.created ? "PAG initialized at " + home() + "\nGateway API key (shown once): " + init.key : "PAG already initialized at " + home());
    return;
  }
  if (!existsSync(configPath()) || !existsSync(secretsPath())) throw new Error("Run pag init first");
  if (command === "serve") return startGateway();
  if (command === "auth") {
    const [action, name] = args;
    if (action === "login" && name === "openai") { await loginChatGPT(); return; }
    if (action === "models") {
      const account = requireArg(name, "Specify provider account");
      const config = loadConfig(), secrets = loadSecrets();
      if (config.accounts[account]?.auth === "chatgpt-oauth") {
        const token = await getOAuthToken(account, secrets);
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error("Model listing unavailable (HTTP " + response.status + ")");
        const body = await response.json() as { models?: Array<{ slug: string; display_name: string; visibility?: string }> };
        console.log(JSON.stringify((body.models ?? []).filter(m => m.visibility === "list").map(m => ({ model: m.slug, name: m.display_name })), null, 2));
        return;
      }
      const provider = config.accounts[account];
      const key = secrets.accounts[account];
      if (!provider || !key) throw new Error("Unknown provider or missing credentials: " + account);
      const baseUrl = provider.baseUrl.replace(/\/+$/, "");
      const response = await fetch(baseUrl + "/models", {
        headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error("Model listing unavailable (HTTP " + response.status + ")");
      const body = await response.json() as { data?: Array<{ id: string }> };
      console.log(JSON.stringify((body.data ?? []).map(m => m.id), null, 2));
      return;
    }
    if (action === "list") { console.log(JSON.stringify(Object.entries(loadConfig().accounts).map(([id, a]) => ({ id, kind: a.kind, baseUrl: a.baseUrl, configured: !!(loadSecrets().accounts[id] || loadSecrets().oauth?.[id]) })), null, 2)); return; }
    if (action === "add") {
      const id = requireArg(name, "Missing account name");
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) throw new Error("Invalid account name");
      const kind = (option("--kind") ?? "llm") as Family;
      if (!["llm", "decisions"].includes(kind)) throw new Error("--kind must be llm or decisions");
      if (id === "vercel-decisions" && kind !== "decisions") throw new Error("vercel-decisions requires --kind decisions");
      const baseUrl = option("--base-url") ?? ({
        "opencode-go": "https://opencode.ai/zen/go/v1",
        openrouter: "https://openrouter.ai/api/v1",
        vercel: "https://ai-gateway.vercel.sh/v1",
        "vercel-decisions": "https://ai-gateway.vercel.sh/v1",
        gemini: "https://generativelanguage.googleapis.com/v1beta/openai/"
      } as Record<string, string>)[id] ?? "";
      const decisionUrl = option("--decisions-url");
      if (!baseUrl && !decisionUrl) throw new Error("Pass --base-url or --decisions-url");
      const endpoints = decisionUrl ? { decisions: decisionUrl } : undefined;
      const protocol = option("--protocol") ?? (id === "vercel-decisions" ? "openai" : "systemone");
      if (kind === "decisions" && !["systemone", "openai"].includes(protocol)) throw new Error("Decision protocol must be systemone or openai");
      if (kind !== "decisions" && args.includes("--protocol")) throw new Error("--protocol is only valid for decision accounts");
      checkEndpoint(decisionUrl || baseUrl);
      if (baseUrl) checkEndpoint(baseUrl);
      const key = await readKey(id === "gemini" ? "Gemini" : "Provider");
      const config = loadConfig(), secrets = loadSecrets();
      const account: Account = { kind, baseUrl, ...(endpoints ? { endpoints } : {}),
        ...(kind === "decisions" ? { protocol: protocol as "systemone" | "openai" } : {}),
        ...(args.includes("--paid") ? { paid: true } : {}),
        ...(option("--session") === "opencode" || id === "opencode-go" ? { session: "opencode" } as const : {}) };
      config.accounts[id] = account;
      secrets.accounts[id] = key;
      saveJson(secretsPath(), secrets);
      writeConfig(config);
      console.log(id === "gemini" ? "Gemini API key saved (secret redacted)" : "Configured provider " + id + " (secret redacted)");
      return;
    }
    if (action === "remove") {
      const id = requireArg(name, "Missing account name");
      const config = loadConfig(), secrets = loadSecrets();
      delete config.accounts[id]; delete secrets.accounts[id]; if (secrets.oauth) delete secrets.oauth[id];
      saveJson(secretsPath(), secrets); writeConfig(config);
      console.log("Removed " + id); return;
    }
    throw new Error("Unknown auth command");
  }
  if (command === "route") {
    const [action, name, ...rest] = args;
    const config = loadConfig();
    if (action === "list") { console.log(JSON.stringify(config.routes, null, 2)); return; }
    if (action === "show") { console.log(JSON.stringify(config.routes[requireArg(name, "Missing alias")] ?? null, null, 2)); return; }
    const aliasName = requireArg(name, "Missing alias");
    if (!/^[a-z0-9][\w.-]{0,63}$/i.test(aliasName)) throw new Error("Invalid model alias");
    if (action === "set") {
      const [type, ...targets] = rest;
      if (type !== "llm" && type !== "decisions") throw new Error("Expected family: llm|decisions");
      if (!targets.length) throw new Error("Provide one or more ACCOUNT:MODEL routes");
      const parsed = targets.map(parseTarget);
      for (const t of parsed) if (config.accounts[t.account]?.kind !== type) throw new Error("Unknown or incompatible provider: " + t.account);
      config.routes[aliasName] = { type, targets: parsed, fallback: true };
    } else if (action === "promote") {
      const target = parseTarget(requireArg(rest[0], "Missing target"));
      const route = config.routes[aliasName];
      if (!route) throw new Error("Unknown alias");
      const idx = route.targets.findIndex(x => x.account === target.account && x.model === target.model);
      if (idx < 0) throw new Error("Target not in route");
      route.targets.unshift(...route.targets.splice(idx, 1));
    } else if (action === "fallback") {
      const route = config.routes[aliasName];
      if (!route) throw new Error("Unknown alias");
      if (rest[0] !== "on" && rest[0] !== "off") throw new Error("Expected on|off");
      route.fallback = rest[0] === "on";
    } else throw new Error("Unknown route command");
    writeConfig(config); console.log(JSON.stringify(config.routes[aliasName], null, 2)); return;
  }
  if (command === "status" || command === "doctor") {
    const config = loadConfig(), secrets = loadSecrets();
    const problems: string[] = [];
    for (const [name, route] of Object.entries(config.routes)) {
      if (!route.targets.length) problems.push(name + ": no targets");
      for (const t of route.targets) if (!config.accounts[t.account] || !(secrets.accounts[t.account] || secrets.oauth?.[t.account])) problems.push(name + ": missing credentials or account " + t.account);
    }
    const result = { config: configPath(), accounts: Object.keys(config.accounts), aliases: Object.keys(config.routes),
      configured: Object.keys(secrets.accounts).length + Object.keys(secrets.oauth ?? {}).length, health: problems.length ? "configuration_incomplete" : "configured_not_probed", problems,
      note: "Quota status is unknown until an actual request; no billable inference was used." };
    console.log(JSON.stringify(result, null, 2));
    if (command === "doctor" && problems.length) process.exitCode = 1;
    return;
  }
  throw new Error("Unknown command. Run pag help.");
}
main().catch(e => { console.error("PAG: " + (e as Error).message); process.exitCode = 1; });
