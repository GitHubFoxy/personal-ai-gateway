/**
 * Small importable Jev Core client for projects such as better-axi.
 * Decision provider credentials remain on the Jev Core server.
 */
export { validateChoice } from './decision.mjs';

export function createJevClient({
  baseUrl = process.env.JEV_CORE_URL || 'http://127.0.0.1:8787',
  apiKey = process.env.JEV_CORE_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = new URL('/v1/decisions', baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('JEV_CORE_URL must use http or https');
  }

  return {
    async requestDecision(payload, options = {}) {
      const { timeoutMs = 25000, mockHandler = null, validateResult = null } = options;
      const start = performance.now();
      if (mockHandler) {
        const result = await mockHandler(payload);
        if (validateResult) validateResult(result);
        return {
          result, provider: 'mock', model: 'mock-jev',
          latency_ms: Math.round(performance.now() - start),
        };
      }
      if (!apiKey) throw new Error('JEV_CORE_API_KEY is required to call Jev Core');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError('timeoutMs must be positive');
      }
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + apiKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error('Jev Core connection failed or timed out');
      }
      if (!response.ok) {
        // Do not surface untrusted upstream content or authentication data.
        throw new Error('Jev Core returned HTTP ' + response.status);
      }
      let decision;
      try { decision = await response.json(); }
      catch { throw new Error('Jev Core returned invalid JSON'); }
      if (!decision || !decision.result || !decision.provider) {
        throw new Error('Jev Core returned an invalid response');
      }
      if (validateResult) validateResult(decision.result);
      return decision;
    },
  };
}

/** Backwards-compatible convenience API; reads environment at call time. */
export async function requestDecision(payload, options = {}) {
  return createJevClient().requestDecision(payload, options);
}
