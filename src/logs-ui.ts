/**
 * Request log page at /pag/logs: a black-and-white table over pag.requests.
 *
 * Contract for the backend (written separately):
 *   GET /pag/api/logs?limit&offset&sort&direction[&model][&status][&upstream]
 *     limit      1..200, default 50 (the page sends 25, 50, 100 or 200)
 *     offset     >= 0, rows to skip; the page moves by `limit`
 *     sort       ts | model | status | duration_ms, default ts
 *     direction  asc | desc, default desc
 *     model      exact model name, optional
 *     status     three digits, exact HTTP status, optional
 *     upstream   exact provider name (the route that answered), optional
 *   200 -> { rows: [{ ts, id, model, status, upstream, duration_ms, ttft_ms,
 *                     key_name, user_agent, path }], hasMore: boolean }
 *     ts is ISO 8601 UTC (or ClickHouse "YYYY-MM-DD HH:MM:SS.sss", also UTC).
 *     hasMore is true when at least one more row exists after this page.
 *   Errors -> { error: string } with a non-2xx status.
 *
 * The server must send logsCsp(nonce) as Content-Security-Policy with the page.
 * The page holds no data: every value is loaded from the API and set as text
 * (textContent), never as HTML. URL query (sort, direction, filters, page size,
 * offset) is mirrored into the address bar so a reload keeps the view.
 */

/** CSP for the page; the same policy as /pag/ with the nonce for the inline script and style. */
export function logsCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** Full HTML document for /pag/logs. Pass the same nonce that goes into logsCsp(). */
export function logsPage(nonce: string): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAG — журнал</title>
<style nonce="${nonce}">
:root{--fg:#111;--mute:#6b6b6b;--line:#d9d9d9;--bg:#fff;--soft:#f3f3f3;--field:#fff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#eee;--mute:#999;--line:#333;--bg:#111;--soft:#1b1b1b;--field:#161616}}
:root[data-theme="dark"]{--fg:#eee;--mute:#999;--line:#333;--bg:#111;--soft:#1b1b1b;--field:#161616}
*{box-sizing:border-box}
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;color:var(--fg);background:var(--bg)}
header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin-bottom:12px}
h1{font-size:18px;font-weight:600;margin:0}
a{color:inherit}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:12px}
label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--mute)}
input,select,button{font:inherit;color:var(--fg);background:var(--field);border:1px solid var(--fg);border-radius:4px;padding:5px 8px;min-height:32px}
input{min-width:0;width:140px}
#fStatus{width:80px}
button{cursor:pointer}
button:disabled{opacity:.35;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.wrap{border:1px solid var(--line);border-radius:6px;overflow-x:auto}
.wrap.busy tbody{opacity:.5}
table{border-collapse:collapse;width:100%}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
th{font-weight:600;background:var(--soft)}
th button{background:none;border:0;padding:0;min-height:0;font-weight:600;text-align:left}
th .arr{font-size:11px;margin-left:4px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.bad{font-weight:700}
td.ua{max-width:240px;overflow:hidden;text-overflow:ellipsis}
td.mono{font-family:ui-monospace,monospace;font-size:12.5px}
td.msg{white-space:normal;color:var(--mute);padding:14px 10px}
.muted{color:var(--mute)}
#status{min-height:1.5em;margin:10px 0;font-size:13px}
#status.err{font-weight:600}
.pager{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.pager #range{margin-right:auto}
.note{font-size:12px;color:var(--mute);margin:14px 0 0}
@media (max-width:640px){
  body{padding:12px}
  .hide-sm{display:none}
  input{width:100%}
  form{display:grid;grid-template-columns:1fr 1fr}
  form label{min-width:0}
  #fStatus{width:100%}
  form button{width:100%}
  td.ua{max-width:140px}
}
</style></head><body>
<header><h1>PAG: журнал запросов</h1><a href="/pag/">провайдеры</a></header>
<form id="f" autocomplete="off">
  <label>Модель<input id="fModel" name="model" maxlength="200"></label>
  <label>Статус<input id="fStatus" name="status" inputmode="numeric" maxlength="3" placeholder="200"></label>
  <label>Провайдер<input id="fUpstream" name="upstream" maxlength="200"></label>
  <label>Строк на странице<select id="fLimit"><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="200">200</option></select></label>
  <button type="submit">Применить</button>
  <button type="button" id="reset">Сбросить фильтры</button>
  <button type="button" id="refresh">Обновить</button>
</form>
<div id="status" role="status" aria-live="polite">Загрузка…</div>
<div id="wrap" class="wrap">
<table>
<thead><tr id="head"></tr></thead>
<tbody id="rows"></tbody>
</table>
</div>
<div class="pager">
  <button type="button" id="prev">← Назад</button>
  <span id="range" class="muted"></span>
  <button type="button" id="next">Вперёд →</button>
</div>
<p class="note">Все даты и время — UTC. «Провайдер» — маршрут, который ответил на запрос (upstream). «Ключ клиента» — имя ключа PAG, которым авторизовался клиент; «User-Agent» — программа, из которой пришёл запрос.</p>
<script nonce="${nonce}">
(function(){
var NUM=/^[0-9]{3}$/;
var SORTS=["ts","model","status","duration_ms"];
var LIMITS=[25,50,100,200];
var COLS=[
  {k:"ts",t:"Время, UTC",sort:"ts",cell:function(r){return utc(r.ts);},mono:1},
  {k:"model",t:"Модель",sort:"model",cell:function(r){return r.model;},mono:1},
  {k:"status",t:"Статус",sort:"status",cell:function(r){return r.status;},num:1,bold:1},
  {k:"upstream",t:"Провайдер",cell:function(r){return r.upstream||"—";}},
  {k:"duration_ms",t:"Длительность, мс",sort:"duration_ms",cell:function(r){return r.duration_ms;},num:1},
  {k:"ttft_ms",t:"TTFT, мс",cell:function(r){return r.ttft_ms||"—";},num:1,sm:1},
  {k:"key_name",t:"Ключ клиента",cell:function(r){return r.key_name||"—";}},
  {k:"user_agent",t:"User-Agent",cell:function(r){return r.user_agent||"—";},ua:1,title:function(r){return r.user_agent||"";}},
  {k:"path",t:"Путь",cell:function(r){return r.path;},mono:1,sm:1},
  {k:"id",t:"ID",cell:function(r){return String(r.id||"").slice(0,8);},mono:1,sm:1,title:function(r){return r.id||"";}}
];
var S={sort:"ts",direction:"desc",model:"",status:"",upstream:"",limit:50,offset:0};
var hasMore=false,seq=0,ctl=null;
var $=function(id){return document.getElementById(id);};

function el(tag,attrs,text){var e=document.createElement(tag);for(var k in attrs||{})e[k]=attrs[k];if(text!==undefined)e.textContent=text;return e;}
function setStatus(msg,err){$("status").textContent=msg;$("status").className=err?"err":"";}
function setBusy(on){$("wrap").classList.toggle("busy",on);}

// "2026-11-21T13:42:01.123Z" or "2026-11-21 13:42:01.123" -> "2026-11-21 13:42:01.123 UTC"
function utc(v){
  var s=String(v==null?"":v);
  var m=/^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}:[0-9]{2})([.][0-9]{1,9})?/.exec(s);
  return m?m[1]+" "+m[2]+(m[3]?m[3].slice(0,4):"")+" UTC":s;
}

function fromUrl(){
  var p=new URLSearchParams(location.search);
  if(SORTS.indexOf(p.get("sort"))>=0)S.sort=p.get("sort");
  if(p.get("direction")==="asc"||p.get("direction")==="desc")S.direction=p.get("direction");
  if(NUM.test(p.get("status")||""))S.status=p.get("status");
  S.model=(p.get("model")||"").slice(0,200);
  S.upstream=(p.get("upstream")||"").slice(0,200);
  var l=Number(p.get("limit"));if(LIMITS.indexOf(l)>=0)S.limit=l;
  var o=Number(p.get("offset"));if(o===Math.floor(o)&&o>=0)S.offset=o;
}
function syncUrl(){
  var p=new URLSearchParams();
  p.set("sort",S.sort);p.set("direction",S.direction);p.set("limit",String(S.limit));p.set("offset",String(S.offset));
  if(S.model)p.set("model",S.model);
  if(S.status)p.set("status",S.status);
  if(S.upstream)p.set("upstream",S.upstream);
  history.replaceState(null,"",location.pathname+"?"+p.toString());
}
function fillForm(){
  $("fModel").value=S.model;$("fStatus").value=S.status;$("fUpstream").value=S.upstream;$("fLimit").value=String(S.limit);
}

function buildHead(){
  var tr=$("head");
  COLS.forEach(function(c){
    var th=el("th",{className:c.num?"num":""});
    th.dataset.k=c.k;
    if(c.sort){
      var b=el("button",{type:"button"},c.t);
      b.dataset.sort=c.sort;
      var a=el("span",{className:"arr"});a.setAttribute("aria-hidden","true");
      b.append(a);th.append(b);
    }else th.textContent=c.t;
    if(c.sm)th.className+=" hide-sm";
    tr.append(th);
  });
}
function updateHead(){
  document.querySelectorAll("#head th").forEach(function(th){
    var k=th.dataset.k;
    var col=COLS.filter(function(c){return c.k===k;})[0];
    if(!col||!col.sort)return;
    var on=S.sort===col.sort;
    th.setAttribute("aria-sort",on?(S.direction==="asc"?"ascending":"descending"):"none");
    var a=th.querySelector(".arr");if(a)a.textContent=on?(S.direction==="asc"?"▲":"▼"):"";
  });
}

function msgRow(text,err){
  var tr=el("tr");var td=el("td",{colSpan:COLS.length,className:"msg"},text);
  if(err)td.className+=" bad";
  tr.append(td);return tr;
}
function rowEl(r){
  var tr=el("tr");
  COLS.forEach(function(c){
    var cls=[];
    if(c.num)cls.push("num");
    if(c.sm)cls.push("hide-sm");
    if(c.ua)cls.push("ua");
    if(c.mono)cls.push("mono");
    if(c.bold&&Number(r.status)>=400)cls.push("bad");
    var td=el("td",{className:cls.join(" ")});
    td.textContent=String(c.cell(r)==null?"":c.cell(r));
    if(c.title)td.title=c.title(r);
    tr.append(td);
  });
  return tr;
}

async function fetchLogs(signal){
  var p=new URLSearchParams({limit:String(S.limit),offset:String(S.offset),sort:S.sort,direction:S.direction});
  if(S.model)p.set("model",S.model);
  if(S.status)p.set("status",S.status);
  if(S.upstream)p.set("upstream",S.upstream);
  var r=await fetch("/pag/api/logs?"+p.toString(),{credentials:"same-origin",cache:"no-store",signal:signal,headers:{accept:"application/json"}});
  var j=await r.json().catch(function(){return null;});
  if(!r.ok)throw new Error((j&&j.error)||("HTTP "+r.status));
  if(!j||!Array.isArray(j.rows))throw new Error("неожиданный ответ сервера");
  return j;
}

function show(j){
  var rows=j.rows;hasMore=j.hasMore===true;
  var body=$("rows");body.replaceChildren();
  if(!rows.length){
    var filtered=S.model||S.status||S.upstream;
    body.append(msgRow(S.offset>0?"На этой странице записей нет. Вернитесь назад.":filtered?"По этим фильтрам записей нет.":"Записей пока нет."));
  }else rows.forEach(function(r){body.append(rowEl(r));});
  $("range").textContent=rows.length?"Строки "+(S.offset+1)+"–"+(S.offset+rows.length):"";
  $("prev").disabled=S.offset===0;
  $("next").disabled=!hasMore;
  setStatus("Готово. Строк на странице: "+rows.length);
}
function showError(e){
  $("rows").replaceChildren(msgRow("Не удалось загрузить записи. Проверьте соединение и нажмите «Обновить».",true));
  $("range").textContent="";
  $("prev").disabled=true;$("next").disabled=true;
  setStatus("Ошибка: "+e.message,true);
}

async function load(){
  var my=++seq;
  if(ctl)ctl.abort();
  ctl=new AbortController();
  syncUrl();updateHead();
  setBusy(true);setStatus("Загрузка…");
  try{
    var j=await fetchLogs(ctl.signal);
    if(my!==seq)return;
    show(j);
  }catch(e){
    if(my!==seq)return;
    showError(e);
  }finally{
    if(my===seq)setBusy(false);
  }
}

$("f").addEventListener("submit",function(e){
  e.preventDefault();
  var st=$("fStatus").value.trim();
  if(st&&!NUM.test(st)){setStatus("Статус — это три цифры, например 200.",true);return;}
  S.model=$("fModel").value.trim();
  S.status=st;
  S.upstream=$("fUpstream").value.trim();
  S.limit=Number($("fLimit").value);
  S.offset=0;
  load();
});
$("reset").addEventListener("click",function(){
  S.model="";S.status="";S.upstream="";S.offset=0;
  fillForm();load();
});
$("refresh").addEventListener("click",function(){load();});
$("prev").addEventListener("click",function(){S.offset=Math.max(0,S.offset-S.limit);load();});
$("next").addEventListener("click",function(){if(hasMore){S.offset+=S.limit;load();}});
$("head").addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("button[data-sort]"):null;
  if(!b)return;
  var k=b.dataset.sort;
  if(S.sort===k)S.direction=S.direction==="asc"?"desc":"asc";
  else{S.sort=k;S.direction=k==="model"?"asc":"desc";}
  S.offset=0;
  load();
});

fromUrl();fillForm();buildHead();load();
})();
</script></body></html>`;
}
