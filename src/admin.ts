/**
 * Switch page at /pag/: Claude and Gemini provider, Codex model toggles.
 * No password: it is reachable only through Tailscale Serve (HTTPS, tailnet only).
 * Guards: request must come from the local Serve proxy (peer address) with an
 * allowed Host; changes need POST + JSON + same Origin + Sec-Fetch-Site
 * same-origin (when sent) + a per-process CSRF token header.
 */
import type http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Prefixes, Settings } from "./routing.ts";
import { logsCsp, logsPage } from "./logs-ui.ts";
import { parseLogQuery, type LogQuery } from "./logs.ts";

export type AdminCfg = { hosts: string[]; peers: string[] };
export type AdminCtx = {
  cfg: AdminCfg;
  csrf: string;
  prefixes: Prefixes;
  keys: { name: string; scope: string; file: string }[];
  getSettings(): Settings;
  /** Validate, persist, then apply. Throws on invalid input. */
  update(patch: Record<string, unknown>, who: string): Settings;
  /** CLIProxyAPI model list (OpenAI shape: id, owned_by). */
  listModels(): Promise<{ id: string; owned_by?: string }[]>;
  listLogs(query: LogQuery): Promise<{ rows: unknown[]; hasMore: boolean }>;
};

const peer = (a = "") => a.replace(/^::ffff:/, "");
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Returns a reason to refuse, or undefined. */
export function adminGuard(req: { method?: string; headers: http.IncomingHttpHeaders; remote?: string; api: boolean }, cfg: AdminCfg, csrf: string): string | undefined {
  const h = req.headers;
  if (!cfg.peers.includes(peer(req.remote))) return "open this page through Tailscale Serve";
  const host = String(h.host ?? "");
  if (!cfg.hosts.includes(host)) return "unexpected Host";
  const site = h["sec-fetch-site"];
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.api && site !== undefined && site !== "same-origin") return "cross-site request";
    return undefined;
  }
  if (req.method !== "POST") return "method not allowed";
  if (h.origin !== `https://${host}`) return "bad Origin";
  if (site !== undefined && site !== "same-origin") return "cross-site request";
  if (!String(h["content-type"] ?? "").toLowerCase().startsWith("application/json")) return "JSON required";
  if (!eq(String(h["x-pag-csrf"] ?? ""), csrf)) return "bad CSRF token";
  return undefined;
}

const SEC_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SEC_HEADERS, "content-type": "application/json", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" }).end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 64 * 1024) throw new Error("body too large"); chunks.push(c as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function state(ctx: AdminCtx) {
  const byPrefix = new Map<string, string[]>();
  const codex: string[] = [];
  let modelsError = "";
  try {
    for (const m of await ctx.listModels()) {
      const slash = m.id.indexOf("/");
      if (slash > 0) { const p = m.id.slice(0, slash); byPrefix.set(p, [...(byPrefix.get(p) ?? []), m.id.slice(slash + 1)]); }
      else if (m.owned_by === "openai") codex.push(m.id);
    }
  } catch (e) { modelsError = (e as Error).message; }
  const s = ctx.getSettings();
  const providers = Object.fromEntries((["claude", "gemini"] as const).map(f => [f,
    Object.entries(ctx.prefixes[f]).map(([name, prefix]) => ({ name, models: (byPrefix.get(prefix) ?? []).sort() }))]));
  for (const m of s.codexDisabled) if (!codex.includes(m)) codex.push(m);
  return { settings: s, providers, codexModels: codex.sort(), keys: ctx.keys, modelsError };
}

/** Handles /pag and /pag/*. Returns false if the path is not ours. */
export async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, path: string, ctx: AdminCtx): Promise<boolean> {
  if (path !== "/pag" && !path.startsWith("/pag/")) return false;
  const api = path.startsWith("/pag/api/");
  const refused = adminGuard({ method: req.method, headers: req.headers, remote: req.socket.remoteAddress, api }, ctx.cfg, ctx.csrf);
  if (refused) { req.resume(); json(res, 403, { error: refused }); return true; }
  const who = String(req.headers["tailscale-user-login"] ?? "unknown");
  if (path === "/pag") { res.writeHead(308, { ...SEC_HEADERS, location: "/pag/" }).end(); return true; }
  if (path === "/pag/" && req.method === "GET") {
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    res.end(page(nonce, ctx.csrf));
    return true;
  }
  if (path === "/pag/logs" && req.method === "GET") {
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": logsCsp(nonce) });
    res.end(logsPage(nonce));
    return true;
  }
  if (path === "/pag/api/logs" && req.method === "GET") {
    let query: LogQuery;
    try { query = parseLogQuery(new URL(req.url ?? "", "http://localhost").searchParams); }
    catch { json(res, 400, { error: "Некорректные параметры запроса" }); return true; }
    try { json(res, 200, await ctx.listLogs(query)); }
    catch (e) { console.error("log query failed:", (e as Error).message); json(res, 503, { error: "Не удалось загрузить журнал" }); }
    return true;
  }
  if (path === "/pag/api/state" && req.method === "GET") { json(res, 200, await state(ctx)); return true; }
  if (path === "/pag/api/settings" && req.method === "POST") {
    let patch: unknown;
    try { patch = await readJson(req); } catch { json(res, 400, { error: "invalid JSON" }); return true; }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) { json(res, 400, { error: "expected an object" }); return true; }
    try { ctx.update(patch as Record<string, unknown>, who); } catch (e) { json(res, 422, { error: (e as Error).message }); return true; }
    json(res, 200, await state(ctx));
    return true;
  }
  req.resume();
  json(res, 404, { error: "not found" });
  return true;
}

function page(nonce: string, csrf: string): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAG — провайдеры</title>
<style nonce="${nonce}">
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#fff;background:#000}
h1{font-size:1.4rem;margin:0}h2{font-size:1rem;margin:0 0 .75rem}
a{color:inherit;text-underline-offset:3px}
section{border:1px solid #fff;padding:1rem 1.25rem;margin:1rem 0;overflow-wrap:anywhere}
label{display:block;margin:.4rem 0;cursor:pointer}
input{accent-color:#fff}input:focus-visible,a:focus-visible{outline:2px solid #fff;outline-offset:3px}
.models{color:#aaa;font-size:13px;margin:.1rem 0 .6rem 1.6rem}
.grid{columns:2;column-gap:2rem}
#status{border:1px solid #fff;padding:.5rem .75rem;min-height:1.5em}
#status.err{background:#fff;color:#000;font-weight:600}
code{font-size:13px}table{border-collapse:collapse;width:100%}td{padding:.3rem .8rem .3rem 0;vertical-align:top}
@media(max-width:560px){body{margin:1rem auto}.grid{columns:1}section{padding:1rem}td{display:block;padding:.1rem 0}tr{display:block;border-top:1px solid #fff;padding:.5rem 0}}
</style></head><body>
<h1>PAG: выбор провайдеров</h1>
<p><a href="/pag/logs">Журнал запросов</a></p>
<div id="status">Загрузка…</div>
<section><h2>Claude</h2><div id="claude"></div></section>
<section><h2>Gemini</h2><div id="gemini"></div></section>
<section><h2>Codex (ChatGPT OAuth): включённые модели</h2><div id="codex" class="grid"></div></section>
<section><h2>Ключи PAG</h2><p>Значения ключей хранятся только на сервере, в файлах ниже.</p><table id="keys"></table></section>
<p>Переключение действует на следующие запросы, в том числе в уже открытых диалогах. Запросы, которые уже выполняются, не прерываются. При ошибке выбранного провайдера PAG возвращает ошибку клиенту и сам не переключается.</p>
<script nonce="${nonce}">
const CSRF=${JSON.stringify(csrf)};
const $=id=>document.getElementById(id);
function el(tag,attrs,text){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs||{}))e[k]=v;if(text!==undefined)e.textContent=text;return e;}
function status(msg,err){$("status").textContent=msg;$("status").className=err?"err":"";}
async function call(url,body){
  const r=await fetch(url,body?{method:"POST",headers:{"content-type":"application/json","x-pag-csrf":CSRF},body:JSON.stringify(body),credentials:"same-origin"}:{credentials:"same-origin"});
  const j=await r.json().catch(()=>({error:"HTTP "+r.status}));
  if(!r.ok)throw new Error(j.error||("HTTP "+r.status));
  return j;
}
function render(s){
  for(const fam of ["claude","gemini"]){
    const box=$(fam);box.replaceChildren();
    for(const p of s.providers[fam]){
      const input=el("input",{type:"radio",name:fam,value:p.name,checked:s.settings[fam]===p.name});
      input.addEventListener("change",()=>save({[fam]:p.name},fam+" → "+p.name));
      const label=el("label");label.append(input," "+p.name);box.append(label);
      box.append(el("div",{className:"models"},p.models.length?p.models.join(", "):"модели не найдены"));
    }
  }
  const codex=$("codex");codex.replaceChildren();
  if(!s.codexModels.length)codex.append(el("p",{},"Список моделей недоступен"));
  for(const m of s.codexModels){
    const input=el("input",{type:"checkbox",checked:!s.settings.codexDisabled.includes(m)});
    input.addEventListener("change",()=>{
      const off=new Set(s.settings.codexDisabled);input.checked?off.delete(m):off.add(m);
      save({codexDisabled:[...off]},m+(input.checked?" включена":" выключена"));
    });
    const label=el("label");label.append(input," ",el("code",{},m));codex.append(label);
  }
  const keys=$("keys");keys.replaceChildren();
  for(const k of s.keys){
    const file=el("td");file.append(el("code",{},k.file));
    const tr=el("tr");tr.append(el("td",{},k.name),el("td",{},k.scope==="all"?"все модели":k.scope),file);keys.append(tr);
  }
  state=s;
}
let state;
async function save(patch,what){
  status("Сохранение…");
  try{render(await call("/pag/api/settings",patch));status("Сохранено: "+what);}
  catch(e){status("Ошибка: "+e.message,true);render(state);}
}
call("/pag/api/state").then(s=>{render(s);status(s.modelsError?"Не удалось получить список моделей: "+s.modelsError:"Готово",!!s.modelsError);}).catch(e=>status("Ошибка: "+e.message,true));
</script></body></html>`;
}
