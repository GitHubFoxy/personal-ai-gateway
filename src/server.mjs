import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { requestFromProviders } from './decision.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

function equalSecret(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

/**
 * @param {{apiKey?:string,env?:object,fetchImpl?:Function,timeoutMs?:number}} options
 */
export function createJevServer(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || env.JEV_CORE_API_KEY;
  if (!apiKey) throw new Error('JEV_CORE_API_KEY must be configured before starting server');

  return createHttpServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok' });
    }
    if (req.url !== '/v1/decisions') return send(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ') || !equalSecret(header.slice(7), apiKey)) {
      return send(res, 401, { error: 'unauthorized' });
    }

    let body = '';
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          return send(res, 413, { error: 'payload_too_large' });
        }
        body += chunk.toString('utf8');
      }
      const payload = JSON.parse(body);
      const result = await requestFromProviders(payload, {
        env, fetchImpl: options.fetchImpl || globalThis.fetch,
        timeoutMs: options.timeoutMs || 25000,
      });
      return send(res, 200, result);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
        return send(res, 400, { error: 'invalid_request' });
      }
      if (error.message === 'No decision provider configured') {
        return send(res, 503, { error: 'provider_not_configured' });
      }
      return send(res, 502, { error: 'decision_unavailable' });
    }
  });
}
