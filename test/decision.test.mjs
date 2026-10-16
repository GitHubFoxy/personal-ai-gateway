import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredProviders, requestFromProviders, validateChoice } from '../src/decision.mjs';
import { createJevClient } from '../src/client.mjs';

const payload = {
  state: { subject: 'test' },
  questions: {
    verdict: { type: 'choice', criteria: { YES: 'yes', NO: 'no' }, instructions: 'Pick one' },
  },
};

test('provider pool order and gateway request translation', () => {
  const providers = configuredProviders({
    OPENROUTER_API_KEY: 'or-secret', JEV_OPENROUTER_MODELS: 'a,b',
    AI_GATEWAY_API_KEY: 'vg-secret',
    CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'cf-secret',
  });
  assert.deepEqual(providers.map((p) => p.name), [
    'openrouter', 'openrouter', 'vercel-gateway', 'cloudflare',
  ]);
  assert.equal(typeof providers[2].buildBody(payload).questions.verdict.instructions, 'string');
});

test('falls back on provider error and validates returned choice', async () => {
  const called = [];
  const result = await requestFromProviders(payload, {
    env: { OPENROUTER_API_KEY: 'secret', JEV_OPENROUTER_MODELS: 'bad,good' },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      called.push(body.model);
      if (body.model === 'bad') return { ok: false, status: 429 };
      return { ok: true, json: async () => ({ answers: { verdict: { choice: 'YES' } } }) };
    },
  });
  assert.deepEqual(called, ['bad', 'good']);
  assert.equal(result.model, 'good');
  assert.equal(validateChoice(result.result.answers.verdict, payload.questions.verdict.criteria), 'YES');
});

test('rejects invalid choices and missing provider configuration', async () => {
  await assert.rejects(requestFromProviders(payload, { env: {} }), /No decision provider configured/);
  await assert.rejects(
    requestFromProviders(payload, {
      env: { OPENROUTER_API_KEY: 'secret' },
      fetchImpl: async () => ({
        ok: true, json: async () => ({ answers: { verdict: { choice: 'INVALID' } } }),
      }),
    }),
    /All decision providers failed/
  );
});

test('client preserves mock-handler behavior without network or credentials', async () => {
  const client = createJevClient({ apiKey: undefined });
  const result = await client.requestDecision(payload, {
    mockHandler: async () => ({ answers: { verdict: { choice: 'YES' } } }),
  });
  assert.equal(result.provider, 'mock');
});
