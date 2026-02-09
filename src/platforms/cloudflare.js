/**
 * Cloudflare Worker entry point (open-source, single-tenant)
 *
 * Uses core's D1Adapter and createAnalyticsHandler for a simple
 * self-hosted Cloudflare Workers deployment with a single D1 database.
 *
 * For the multi-tenant hosted product, see hosted/entry.js.
 */

import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

function includesSafe(list, value) {
  const items = list.split(',').map(t => t.trim());
  let found = false;
  for (const item of items) {
    if (safeEqual(item, value)) found = true;
  }
  return found;
}

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);

    const validateWrite = (_request, body) => {
      if (!env.PROJECT_TOKENS) return { valid: true };
      const token = body?.token;
      if (!token) return { valid: false, error: 'token required' };
      if (!includesSafe(env.PROJECT_TOKENS, token)) return { valid: false, error: 'invalid token' };
      return { valid: true };
    };

    const validateRead = (request, url) => {
      let apiKey = request.headers.get('X-API-Key');
      if (!apiKey && url.searchParams.get('key')) {
        apiKey = url.searchParams.get('key');
        console.warn('Deprecation: API key passed via ?key= query param. Use X-API-Key header instead.');
      }
      if (!env.API_KEYS || !apiKey || !includesSafe(env.API_KEYS, apiKey)) {
        return { valid: false };
      }
      return { valid: true };
    };

    const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : undefined;
    const handleRequest = createAnalyticsHandler({ db, validateWrite, validateRead, allowedOrigins });
    const { response, writeOps } = await handleRequest(request);

    if (writeOps) {
      for (const op of writeOps) {
        ctx.waitUntil(op);
      }
    }

    return response;
  },
};
