import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGateway } from "../src/gateway.ts";
import { type Config } from "../src/config.ts";
import { parseDecision, toOpenAI, toSystemOne, canTranslate, normalizeDecisions } from "../src/decisions.ts";

function mockConfig(): Config {
  return {
    host: "127.0.0.1", port: 4000,
    accounts: {
      openai: { kind: "decisions", baseUrl: "https://api.openai.com/v1", protocol: "openai" },
      jev: { kind: "decisions", baseUrl: "https://openrouter.ai/api/alpha",
        endpoints: { decisions: "https://openrouter.ai/api/alpha/decisions" }, protocol: "systemone" }
    },
    routes: { decision: { type: "decisions", targets: [
      { account: "openai", model: "gpt-6-luna" },
      { account: "jev", model: "typesafe/jev-1.13" }
    ] } },
    fallback: { enabled: true, maxAttempts: 2, cooldownMs: 1, timeoutMs: 5000, allowPaid: true }
  };
}
const systemRequest = () => ({
  model: "decision", state: { ticket: "Payment screen shows error" },
  questions: {
    urgent: { type: "predicate", instructions: "Is urgent?" },
    team: { type: "choice", instructions: "Select team", choices: { payments: "Billing", product: "Bugs" } },
    impact: { type: "score", instructions: "Rate impact", levels: ["Low", "Medium", "High"] }
  }
});
const nativeAnswers = {
  model: "gpt-6-luna",
  answers: [
    { name: "urgent", type: "predicate", probability: 0.82 },
    { name: "team", type: "choice", choice: "payments", confidence: 0.7, probabilities: [
      { value: "payments", probability: 0.7 }, { value: "product", probability: 0.3 }
    ] },
    { name: "impact", type: "score", score: 1.4, confidence: 0.56, probabilities: [
      { value: 0, label: "Low", probability: 0.1 },
      { value: 1, label: "Medium", probability: 0.4 },
      { value: 2, label: "High", probability: 0.5 }
    ] }
  ],
  usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 }
};
async function run(cfg: Config, mock: typeof fetch, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createGateway({
    config: () => cfg,
    secrets: () => ({ gatewayKey: "pag_test", accounts: { openai: "openai-test", jev: "or-test" } }),
    fetcher: mock
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("missing server port");
  try { await fn("http://127.0.0.1:" + addr.port); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
function post(url: string, body: unknown) {
  return fetch(url + "/v1/decisions", {
    method: "POST", headers: { authorization: "Bearer pag_test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("System One public request translates to native OpenAI question array", () => {
  const parsed = parseDecision(systemRequest());
  const native = toOpenAI(parsed, "gpt-6-luna");
  assert.equal(native.model, "gpt-6-luna");
  assert.equal(native.input, JSON.stringify(systemRequest().state));
  const qs = native.questions as Array<Record<string, unknown>>;
  assert.deepEqual(qs.map(q => q.name), ["urgent", "team", "impact"]);
  assert.deepEqual(qs[1].choices, [
    { value: "payments", description: "Billing" }, { value: "product", description: "Bugs" }
  ]);
  assert.deepEqual(qs[2].levels, [
    { label: "Low" }, { label: "Medium" }, { label: "High" }
  ]);
});
test("OpenAI native input maps to System One for compatible fallback", () => {
  const input = {
    model: "decision", input: "Customer asks for a refund",
    questions: [{ name: "team", type: "choice", instructions: "Which?", choices: [
      { value: "billing", description: "Payments" }, { value: "technical", description: "Software" }
    ] }]
  };
  const request = parseDecision(input);
  const system = toSystemOne(request, "typesafe/jev-1.13");
  assert.equal(system.state, input.input);
  assert.deepEqual({ ...(system.questions as Record<string, any>).team.criteria }, { billing: "Payments", technical: "Software" });
});
test("normalize named OpenAI arrays into System One response retaining true distributions", () => {
  const normalized = normalizeDecisions(nativeAnswers, parseDecision(systemRequest()), "decision");
  assert.equal(normalized.model, "decision");
  const a = normalized.answers as Record<string, any>;
  assert.equal(a.urgent.probability, 0.82);
  assert.equal(a.team.choice, "payments");
  assert.equal(a.team.probabilities.payments, 0.7);
  assert.equal(a.impact.score, 1.4);
  assert.equal(a.impact.probabilities["2"], 0.5);
  assert.deepEqual(normalized.usage, nativeAnswers.usage);
});
test("OpenAI wire-format caller receives ordered, named native-style answers", () => {
  const req = parseDecision({
    model: "decision", input: "text",
    questions: [
      { name: "urgent", type: "predicate", instructions: "Is urgent?" },
      { name: "team", type: "choice", instructions: "Choose", choices: [
        { value: "payments", description: "Billing" }, { value: "product", description: "Bugs" }
      ] },
      { name: "impact", type: "score", instructions: "Rate", levels: [
        { label: "Low" }, { label: "Medium" }, { label: "High" }
      ] }
    ]
  });
  const out = normalizeDecisions(nativeAnswers, req, "decision");
  assert.ok(Array.isArray(out.answers));
  const a = out.answers as Array<any>;
  assert.deepEqual(a.map(x => x.name), ["urgent", "team", "impact"]);
  assert.deepEqual(a[1].probabilities, nativeAnswers.answers[1].probabilities);
  assert.deepEqual(a[2].probabilities, nativeAnswers.answers[2].probabilities);
});
test("refusal and absent probability metadata never become fabricated answers", () => {
  const req = parseDecision({ model: "decision", state: "s", questions: {
    yes: { type: "predicate", instructions: "?" },
    team: { type: "choice", instructions: "?", choices: { a: "A", b: "B" } }
  } });
  const output = normalizeDecisions({ answers: { yes: { type: "refusal" }, team: { choice: "b" } } }, req, "decision");
  assert.deepEqual({ ...output.answers as Record<string, unknown> }, { yes: { type: "refusal" }, team: { type: "choice", choice: "b" } });
});
test("reject duplicate names, prototype keys, unrecognized choice and invalid distributions", () => {
  assert.throws(() => parseDecision({ model: "decision", state: "s", questions: {
    constructor: { type: "predicate", instructions: "?" }
  } }), /Invalid question ID/);
  assert.throws(() => parseDecision({ model: "decision", input: "s", questions: [
    { name: "a", type: "predicate", instructions: "?" },
    { name: "a", type: "predicate", instructions: "?" }
  ] }), /Duplicate question/);
  const req = parseDecision(systemRequest());
  assert.throws(() => normalizeDecisions({ answers: { ...Object.fromEntries(
    nativeAnswers.answers.map(a => [a.name, a])),
    team: { choice: "payments", probabilities: [{ value: "hacker", probability: 1 }] }
  } }, req, "decision"), /distribution/);
});
test("Gateway sends native payload, returns normalized aliases and refuses invalid input", async () => {
  const cfg = mockConfig();
  await run(cfg, async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/decisions");
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.questions[0].type, "predicate");
    assert.equal(sent.input, JSON.stringify(systemRequest().state));
    return Response.json(nativeAnswers);
  }, async url => {
    const resp = await post(url, systemRequest());
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("x-pag-provider"), "openai");
    const data = await resp.json();
    assert.equal(data.model, "decision");
    assert.equal(data.answers.team.choice, "payments");
    const bad = await post(url, { model: "decision", input: "s", questions: [
      { name: "team", type: "choice", instructions: "Pick", choices: [{ value: "only", description: "only" }] }
    ] });
    assert.equal(bad.status, 422);
  });
});
test("Native 429 falls back to System One and validates result without changing public model alias", async () => {
  const cfg = mockConfig();
  let calls = 0;
  await run(cfg, async (url, init) => {
    calls++;
    const sent = JSON.parse(String(init?.body));
    if (calls === 1) return new Response("", { status: 429 });
    assert.equal(String(url), "https://openrouter.ai/api/alpha/decisions");
    assert.equal(sent.questions.urgent.type, "noul");
    return Response.json({ answers: {
      urgent: { type: "noul", noul: 0.82 },
      team: { type: "choice", choice: "payments", probabilities: { payments: 0.7, product: 0.3 } },
      impact: { type: "score", score: 1.4 }
    } });
  }, async url => {
    const res = await post(url, systemRequest());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-pag-provider"), "jev");
    assert.equal((await res.json()).answers.urgent.probability, 0.82);
    assert.equal(calls, 2);
  });
});
test("Missing answers trigger fallback; native message-array input skips incompatible System One", async () => {
  const cfg = mockConfig(); let calls = 0;
  await run(cfg, async () => { calls++; return Response.json({ answers: { team: { type: "refusal" } } }); }, async url => {
    const resp = await post(url, { model: "decision", input: [
      { role: "user", content: "Help" }
    ], questions: [{ name: "decision", type: "predicate", instructions: "ok?" }] });
    assert.equal(resp.status, 502);
    assert.equal(calls, 1);
  });
});

test("System One accepts JSON-array state but never sends it as native message objects", () => {
  const request = parseDecision({ model: "decision", state: ["ticket A", "ticket B"],
    questions: { urgent: { type: "predicate", instructions: "Urgent?" } } });
  assert.equal(canTranslate(request, "systemone"), true);
  assert.deepEqual(toSystemOne(request, "jev").state, ["ticket A", "ticket B"]);
  assert.equal(toOpenAI(request, "gpt-6-luna").input, '["ticket A","ticket B"]');
  const native = parseDecision({ model: "decision", input: [{ role: "user", content: "hello" }],
    questions: [{ name: "urgent", type: "predicate", instructions: "Urgent?" }] });
  assert.equal(canTranslate(native, "systemone"), false);
  assert.equal(canTranslate(native, "openai"), true);
});
