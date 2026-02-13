/**
 * Cloudflare Worker entry point (open-source, single-tenant)
 *
 * Uses core's D1Adapter and createAnalyticsHandler for a simple
 * self-hosted Cloudflare Workers deployment with a single D1 database.
 *
 * For the multi-tenant hosted product, see hosted/entry.js.
 */

import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';
import { makeValidateWrite, makeValidateRead } from '../auth.js';

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);
    const validateWrite = makeValidateWrite(env.PROJECT_TOKENS);
    const validateRead = makeValidateRead(env.API_KEYS);
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
