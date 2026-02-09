/**
 * Cloudflare Worker entry point (open-source, single-tenant)
 *
 * Uses core's D1Adapter and createAnalyticsHandler for a simple
 * self-hosted Cloudflare Workers deployment with a single D1 database.
 *
 * For the multi-tenant hosted product, see hosted/entry.js.
 */

import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);

    const validateWrite = (_request, body) => {
      if (!env.PROJECT_TOKENS) return { valid: true };
      const token = body?.token;
      if (!token) return { valid: false, error: 'token required' };
      if (!env.PROJECT_TOKENS.split(',').includes(token)) return { valid: false, error: 'invalid token' };
      return { valid: true };
    };

    const validateRead = (request, url) => {
      const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
      if (!env.API_KEYS || !apiKey || !env.API_KEYS.split(',').includes(apiKey)) {
        return { valid: false };
      }
      return { valid: true };
    };

    const handleRequest = createAnalyticsHandler({ db, validateWrite, validateRead });
    const { response, writeOps } = await handleRequest(request);

    if (writeOps) {
      for (const op of writeOps) {
        ctx.waitUntil(op);
      }
    }

    return response;
  },
};
