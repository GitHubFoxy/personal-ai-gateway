#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { checkEndpoint, configPath, home, initialize, loadConfig, loadSecrets, saveJson, secretsPath, type Account, type Config, type Family, type Target } from "./config.ts";
import { startGateway } from "./gateway.ts";

const [command, ...args] = process.argv.slice(2);
const help = `Personal AI Gateway (PAG)

  pag init
  pag serve
  pag auth add NAME --kind llm|decisions --base-url URL [--session opencode] [--paid] [--key-stdin]
  pag auth list
  pag auth remove NAME
  pag auth login openai           (not available until approved OAuth app flow)
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
async function readKey(): Promise<string> {
  if (args.includes("--key-stdin")) {
    const value = readFileSync(0, "utf8").trim();
    if (!value) throw new Error("Empty upstream key on stdin");
    return value;
  }
  if (!stdin.isTTY) throw new Error("Use --key-stdin to supply upstream key via pipe");
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question("Provider API key (input may be visible): ")).trim(); }
  finally { rl.close(); }
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
    if (action === "login" && name === "openai") throw new Error("ChatGPT subscription OAuth is not yet implemented. Use the supported official Sign in with ChatGPT flow when registered, not an unofficial token workaround.");
    if (action === "list") { console.log(JSON.stringify(Object.entries(loadConfig().accounts).map(([id, a]) => ({ id, kind: a.kind, baseUrl: a.baseUrl, configured: !!loadSecrets().accounts[id] })), null, 2)); return; }
    if (action === "add") {
      const id = requireArg(name, "Missing account name");
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) throw new Error("Invalid account name");
      const kind = (option("--kind") ?? "llm") as Family;
      if (!["llm", "decisions"].includes(kind)) throw new Error("--kind must be llm or decisions");
      const baseUrl = option("--base-url") ?? (id === "opencode-go" ? "https://opencode.ai/zen/go/v1" : id === "openrouter" ? "https://openrouter.ai/api/v1" : "");
      const decisionUrl = option("--decisions-url");
      if (!baseUrl && !decisionUrl) throw new Error("Pass --base-url or --decisions-url");
      const endpoints = decisionUrl ? { decisions: decisionUrl } : undefined;
      checkEndpoint(decisionUrl || baseUrl);
      const key = await readKey();
      const config = loadConfig(), secrets = loadSecrets();
      const account: Account = { kind, baseUrl, ...(endpoints ? { endpoints } : {}),
        ...(args.includes("--paid") ? { paid: true } : {}),
        ...(option("--session") === "opencode" || id === "opencode-go" ? { session: "opencode" } as const : {}) };
      config.accounts[id] = account;
      secrets.accounts[id] = key;
      saveJson(secretsPath(), secrets);
      writeConfig(config);
      console.log("Configured provider " + id + " (secret redacted)");
      return;
    }
    if (action === "remove") {
      const id = requireArg(name, "Missing account name");
      const config = loadConfig(), secrets = loadSecrets();
      delete config.accounts[id]; delete secrets.accounts[id];
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
      for (const t of route.targets) if (!config.accounts[t.account] || !secrets.accounts[t.account]) problems.push(name + ": missing credentials or account " + t.account);
    }
    const result = { config: configPath(), accounts: Object.keys(config.accounts), aliases: Object.keys(config.routes),
      configured: Object.keys(secrets.accounts).length, health: problems.length ? "configuration_incomplete" : "configured_not_probed", problems,
      note: "Quota status is unknown until an actual request; no billable inference was used." };
    console.log(JSON.stringify(result, null, 2));
    if (command === "doctor" && problems.length) process.exitCode = 1;
    return;
  }
  throw new Error("Unknown command. Run pag help.");
}
main().catch(e => { console.error("PAG: " + (e as Error).message); process.exitCode = 1; });
