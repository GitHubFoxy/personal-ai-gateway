import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGateway } from "../src/gateway.ts";
import { type Config } from "../src/config.ts";

let seq = 0;
function config(): Config {
  const n = ++seq;
  return {
    host: "127.0.0.1", port: 4000,
    accounts: {
      a: { kind: "llm", baseUrl: "http://127.0.0.1:9/v1" },
      b: { kind: "llm", baseUrl: "http://127.0.0.1:10/v1" },
      d: { kind: "decisions", baseUrl: "http://127.0.0.1:11/v1" }
    },
    routes: {
      coding: { type: "llm", targets: [{ account: "a", model: "primary-" + n }, { account: "b", model: "backup-" + n }] },
      decision: { type: "decisions", targets: [{ account: "d", model: "clef-" + n }] }
    },
    fallback: { enabled: true, maxAttempts: 3, cooldownMs: 20, timeoutMs: 3000, allowPaid: true }
  };
}
async function run(configured: Config, mock: typeof fetch, fn: (url: string) => Promise<void>) {
  const server = createGateway({ config: () => configured, secrets: () => ({ gatewayKey: "pag_test", accounts: { a: "a_secret", b: "b_secret", d: "d_secret", vd: "vd_secret" }, oauth: { a: { clientId: "", accessToken: "oauth_token", refreshToken: "", idToken: "", expiresAt: Date.now() + 3600000, subject: "", scope: "" } } }), fetcher: mock });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No port");
  try { await fn("http://127.0.0.1:" + addr.port); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
function post(url: string, path: string, body: unknown, token = "pag_test") {
  return fetch(url + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("ChatGPT OAuth accepts string and list Responses input", async () => {
  const cfg = config();
  cfg.accounts.a.auth = "chatgpt-oauth";
  cfg.routes.coding.targets = [cfg.routes.coding.targets[0]];
  const inputs = ["hello", [{ role: "user", content: "hello" }]];
  let calls = 0;
  await run(cfg, async (_url, init) => {
    const outbound = JSON.parse(String(init?.body));
    assert.deepEqual(outbound.input, [{ role: "user", content: "hello" }]);
    calls++;
    return new Response('data: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
  }, async url => {
    for (const input of inputs) {
      const response = await post(url, "/v1/responses", { model: "coding", input, stream: true });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(calls, 2);
  });
});

test("Chat Completions text request uses ChatGPT OAuth Responses", async () => {
  const cfg = config();
  cfg.accounts.a.auth = "chatgpt-oauth";
  cfg.accounts.a.endpoints = { responses: "http://127.0.0.1:9/responses" };
  cfg.routes.coding.targets = [cfg.routes.coding.targets[0]];
  await run(cfg, async (url, init) => {
    assert.equal(url, cfg.accounts.a.endpoints!.responses);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.input, [{ role: "developer", content: "Return JSON" }, { role: "user", content: "hello" }]);
    assert.deepEqual(body.text.format, { type: "json_object" });
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    return new Response('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\\"text\\":\\"hello\\"}"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n', { headers: { "content-type": "text/event-stream" } });
  }, async url => {
    const response = await post(url, "/v1/chat/completions", { model: "coding", messages: [{ role: "system", content: "Return JSON" }, { role: "user", content: "hello" }], response_format: { type: "json_object" }, reasoning: { effort: "low" }, max_tokens: 1024 });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.choices[0].message.content, '{"text":"hello"}');
    assert.equal(result.model, "coding");
    assert.equal(result.usage.total_tokens, 5);
  });
});

test("unsupported ChatGPT OAuth chat options fail without contacting upstream", async () => {
  const cfg = config();
  cfg.accounts.a.auth = "chatgpt-oauth";
  cfg.routes.coding.targets = [cfg.routes.coding.targets[0]];
  await run(cfg, async () => { throw new Error("unexpected upstream request"); }, async url => {
    for (const extra of [{ stream: true }, { tools: [] }, { response_format: "json_object" }]) {
      const response = await post(url, "/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hello" }], ...extra });
      assert.equal(response.status, 422);
    }
  });
});

test("ChatGPT OAuth failed event does not become a successful chat completion", async () => {
  const cfg = config();
  cfg.accounts.a.auth = "chatgpt-oauth";
  cfg.routes.coding.targets = [cfg.routes.coding.targets[0]];
  await run(cfg, async () => new Response('data: {"type":"response.failed"}\n\n'), async url => {
    const response = await post(url, "/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hello" }] });
    assert.equal(response.status, 502);
  });
});

test("authentication, models, stable alias and upstream model", async () => {
  const cfg = config();
  await run(cfg, async (_url, init) => {
    assert.equal((init?.headers as Headers).get("authorization"), "Bearer a_secret");
    assert.equal(JSON.parse(String(init?.body)).model, cfg.routes.coding.targets[0].model);
    return Response.json({ id: "x", model: "actual", output: [{ type: "message", content: [] }] });
  }, async url => {
    assert.equal((await post(url, "/v1/responses", { model: "coding", input: "hi" }, "wrong")).status, 401);
    const models = await fetch(url + "/v1/models", { headers: { authorization: "Bearer pag_test" } });
    assert.equal((await models.json()).data.length, 2);
    const response = await post(url, "/v1/responses", { model: "coding", input: "hi" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-pag-provider"), "a");
    assert.equal((await response.json()).model, "coding");
  });
});

test("fallback from upstream 429 to backup, then manual priority change", async () => {
  const cfg = config(); const calls: string[] = [];
  await run(cfg, async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    calls.push(model);
    return calls.length === 1 ? new Response("rate limited", { status: 429 }) : Response.json({ id: "ok", model });
  }, async url => {
    const res = await post(url, "/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).model, "coding");
    assert.equal(calls.length, 2);
    cfg.routes.coding.targets.reverse(); // models are routed from fresh config for the next request
    const next = await post(url, "/v1/chat/completions", { model: "coding", messages: [] });
    assert.equal(next.headers.get("x-pag-provider"), "b");
  });
});

test("decisions: map predicate to noul, preserve provider probabilities", async () => {
  const cfg = config();
  await run(cfg, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.questions.urgent.type, "noul");
    assert.deepEqual(Object.keys(request.questions.team.criteria), ["ops", "sales"]);
    return Response.json({ result: { answers: {
      urgent: { noul: 0.9 },
      team: { choice: "ops", confidence: 0.72 },
      severity: { score: 1.25 }
    } } });
  }, async url => {
    const r = await post(url, "/v1/decisions", { model: "decision", state: "outage", questions: {
      urgent: { type: "predicate", instructions: "Urgent?" },
      team: { type: "choice", instructions: "Team?", choices: { ops: "operations", sales: "sales" } },
      severity: { type: "score", instructions: "Rate", levels: ["low", "med", "high"] }
    } });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.answers.urgent.probability, 0.9);
    assert.equal(data.answers.team.choice, "ops");
    assert.equal(data.answers.severity.score, 1.25);
    assert.equal("confidence" in data.answers.urgent, false);
  });
});

test("Vercel Decisions API: translate request and normalize typed answers", async () => {
  const cfg = config();
  cfg.accounts.vd = { kind: "decisions", baseUrl: "http://127.0.0.1:12/v1", protocol: "openai" };
  cfg.routes.decision.targets = [{ account: "vd", model: "convaiinnovations/laya-free" }];
  await run(cfg, async (url, init) => {
    assert.equal(url, "http://127.0.0.1:12/v1/decisions");
    assert.equal((init?.headers as Headers).get("authorization"), "Bearer vd_secret");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "convaiinnovations/laya-free");
    assert.equal(request.input, "refund request");
    assert.deepEqual(request.questions[0], { type: "predicate", name: "urgent", instructions: "Urgent?" });
    assert.deepEqual(request.questions[1].choices, [{ value: "ops", description: "operations" }, { value: "sales", description: "sales" }]);
    assert.deepEqual(request.questions[2].levels.map((level: { label: string }) => level.label), ["low", "med", "high"]);
    return Response.json({ answers: [
      { type: "predicate", name: "urgent", probability: 0.9 },
      { type: "choice", name: "team", choice: "ops", confidence: 0.8, probabilities: [{ value: "ops", probability: 0.8 }, { value: "sales", probability: 0.2 }] },
      { type: "score", name: "severity", score: 1.25, confidence: 0.7 }
    ] });
  }, async url => {
    const r = await post(url, "/v1/decisions", { model: "decision", state: "refund request", questions: {
      urgent: { type: "predicate", instructions: "Urgent?" },
      team: { type: "choice", instructions: "Team?", choices: { ops: "operations", sales: "sales" } },
      severity: { type: "score", instructions: "Rate", levels: ["low", "med", "high"] }
    } });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.answers.urgent.probability, 0.9);
    assert.equal(data.answers.team.choice, "ops");
    assert.equal(data.answers.team.probabilities.ops, 0.8);
    assert.equal(data.answers.severity.score, 1.25);
  });
});

test("invalid decision and 2 MiB body protections", async () => {
  const cfg = config();
  await run(cfg, async () => { throw new Error("should not call upstream"); }, async url => {
    const invalid = await post(url, "/v1/decisions", { model: "decision", state: {}, questions: { team: { type: "choice", instructions: "choose", choices: { only: "one" } } } });
    assert.equal(invalid.status, 422);
    const large = await post(url, "/v1/responses", { model: "coding", input: "a".repeat(2_200_000) });
    assert.equal(large.status, 413);
  });
});

test("streaming fallback happens before headers; stream passes through", async () => {
  const cfg = config(); let count = 0;
  await run(cfg, async (_url, init) => {
    count++;
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    if (count === 1) return new Response("", { status: 503 });
    return new Response("data: {\"type\":\"response.completed\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }, async url => {
    const r = await post(url, "/v1/responses", { model: "coding", stream: true, input: "hello" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-pag-provider"), "b");
    assert.match(await r.text(), /response.completed/);
    assert.equal(count, 2);
  });
});

test("retryable routes exhausted and disabled paid routes", async () => {
  const cfg = config(); cfg.accounts.a.paid = true; cfg.accounts.b.paid = true; cfg.fallback.allowPaid = false;
  await run(cfg, async () => Response.json({}), async url => {
    const r = await post(url, "/v1/responses", { model: "coding", input: "hi" });
    assert.equal(r.status, 503);
  });
});

test("ChatGPT early streamed quota event falls back before data is emitted", async () => {
  const cfg = config(); let calls = 0;
  await run(cfg, async (_url, init) => {
    calls++;
    if (calls === 1) return new Response('event: response.failed\\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\\n\\n', {
      status: 200, headers: { "content-type": "text/event-stream" }
    });
    assert.equal(JSON.parse(String(init?.body)).model, cfg.routes.coding.targets[1].model);
    return new Response('data: {"type":"response.completed"}\\n\\n', {
      status: 200, headers: { "content-type": "text/event-stream" }
    });
  }, async url => {
    const response = await post(url, "/v1/responses", { model: "coding", input: "Hi", stream: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-pag-provider"), "b");
    assert.match(await response.text(), /response.completed/);
    assert.equal(calls, 2);
  });
});
