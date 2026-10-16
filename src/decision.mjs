/**
 * The decision engine belongs to Jev Core. No browser or job-search dependencies.
 * It translates requests and falls back across configured decision models/providers.
 */

export function validateChoice(answer, criteria) {
  if (!answer || !criteria || typeof criteria !== 'object' ||
      !Object.hasOwn(criteria, answer.choice)) {
    throw new Error('Invalid or missing decision choice');
  }
  return answer.choice;
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !payload.questions || typeof payload.questions !== 'object' ||
      Array.isArray(payload.questions) || !Object.keys(payload.questions).length) {
    throw new TypeError('state and a non-empty questions object are required');
  }
  for (const question of Object.values(payload.questions)) {
    if (!question || question.type !== 'choice' || !question.criteria ||
        typeof question.criteria !== 'object' || Array.isArray(question.criteria) ||
        !Object.keys(question.criteria).length) {
      throw new TypeError('Each question requires type=choice and non-empty criteria');
    }
  }
}

function validateResponse(payload, response) {
  if (!response || !response.answers || typeof response.answers !== 'object' ||
      Array.isArray(response.answers) || !Object.keys(response.answers).length) {
    throw new Error('Provider returned no answers');
  }
  for (const [name, answer] of Object.entries(response.answers)) {
    if (!Object.hasOwn(payload.questions, name)) {
      throw new Error('Provider returned an unknown question');
    }
    validateChoice(answer, payload.questions[name].criteria);
  }
  return response;
}

function listModels(value, fallback) {
  return [...new Set(String(value || fallback).split(',').map((s) => s.trim()).filter(Boolean))];
}

function stringifyInstructions(instructions) {
  if (typeof instructions === 'string') return instructions;
  if (!instructions || typeof instructions !== 'object') return String(instructions ?? '');
  return Object.entries(instructions).map(([k, v]) =>
    k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
}

function gatewayQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([key, q]) =>
    [key, { ...q, instructions: stringifyInstructions(q.instructions) }]));
}

export function configuredProviders(env = process.env) {
  const providers = [];
  if (env.OPENROUTER_API_KEY) {
    for (const model of listModels(env.JEV_OPENROUTER_MODELS, 'typesafe/jev-1.14')) {
      providers.push({
        name: 'openrouter', model, token: env.OPENROUTER_API_KEY,
        url: 'https://openrouter.ai/api/alpha/decisions',
        buildBody: (payload) => ({ ...payload, model }),
      });
    }
  }
  if (env.AI_GATEWAY_API_KEY) {
    for (const model of listModels(env.JEV_GATEWAY_MODELS || env.AI_GATEWAY_MODEL,
                                   'typesafe-ai/jev-1.14.0')) {
      providers.push({
        name: 'vercel-gateway', model, token: env.AI_GATEWAY_API_KEY,
        url: 'https://ai-gateway.vercel.sh/v1/evaluate',
        buildBody: (payload) => ({
          ...payload, model, questions: gatewayQuestions(payload.questions),
          ...(env.AI_GATEWAY_PROVIDER ?
            { providerOptions: { gateway: { only: [env.AI_GATEWAY_PROVIDER] } } } : {}),
        }),
      });
    }
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    for (const model of listModels(env.JEV_CLOUDFLARE_MODELS || env.CLOUDFLARE_AI_MODEL,
                                   '@cf/cloudflare/clef')) {
      providers.push({
        name: 'cloudflare', model, token: env.CLOUDFLARE_API_TOKEN,
        url: 'https://api.cloudflare.com/client/v4/accounts/' +
          encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID) + '/ai/run/' + model,
        buildBody: (payload) => ({
          ...payload, model: model.split('/').at(-1),
          questions: gatewayQuestions(payload.questions),
        }),
      });
    }
  }
  return providers;
}

/**
 * Requests providers sequentially under one overall timeout.
 * Upstream error bodies are deliberately not exposed (may contain secrets).
 */
export async function requestFromProviders(payload, options = {}) {
  validatePayload(payload);
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = 25000,
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be positive');
  }
  const providers = configuredProviders(env);
  if (!providers.length) throw new Error('No decision provider configured');
  const deadline = performance.now() + timeoutMs;
  const failed = [];

  for (const provider of providers) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    const start = performance.now();
    try {
      const res = await fetchImpl(provider.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + provider.token,
        },
        body: JSON.stringify(provider.buildBody(payload)),
        signal: AbortSignal.timeout(remaining),
      });
      if (!res.ok) {
        failed.push(provider.name + '/' + provider.model + ': HTTP ' + res.status);
        continue;
      }
      const json = await res.json();
      const candidate = json && json.answers ? json :
        (json && json.result && json.result.answers ? json.result : json);
      return {
        result: validateResponse(payload, candidate),
        provider: provider.name,
        model: provider.model,
        latency_ms: Math.round(performance.now() - start),
      };
    } catch {
      failed.push(provider.name + '/' + provider.model + ': request or response failed');
    }
  }
  if (performance.now() >= deadline) failed.push('deadline exhausted');
  throw new Error('All decision providers failed: ' + failed.join('; '));
}
