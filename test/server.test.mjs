import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createJevServer } from '../src/server.mjs';

const payload = {
  state: { item: 1 },
  questions: { test: { type: 'choice', criteria: { A: 'Option A' } } },
};

test('HTTP API authenticates and returns the provider result', async () => {
  const server = createJevServer({
    apiKey: 'local-secret',
    env: { OPENROUTER_API_KEY: 'provider-secret' },
    fetchImpl: async () => ({
      ok: true, json: async () => ({ answers: { test: { choice: 'A' } } }),
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const denied = await fetch(url + '/v1/decisions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(url + '/v1/decisions', {
      method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer local-secret',
      }, body: JSON.stringify(payload),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).result.answers.test.choice, 'A');
    const health = await fetch(url + '/health');
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
