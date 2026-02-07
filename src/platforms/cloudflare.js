/**
 * Cloudflare Worker entry point
 *
 * Uses @agent-analytics/core for all handler logic.
 * Auth via env-var based validateApiKey / validateProjectToken.
 */

import { createAnalyticsHandler, D1Adapter } from '@agent-analytics/core';
import { validateApiKey, validateProjectToken } from '../auth.js';

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);
    const handler = createAnalyticsHandler({
      db,
      validateWrite: (req, body) => validateProjectToken(body.token, env.PROJECT_TOKENS),
      validateRead: (req, url) => validateApiKey(req, url, env.API_KEYS),
      useQueue: !!env.ANALYTICS_QUEUE,
    });

    const { response, writeOps, queueMessages } = await handler(request);

    if (env.ANALYTICS_QUEUE && queueMessages?.length) {
      ctx.waitUntil(
        env.ANALYTICS_QUEUE.sendBatch(queueMessages.map(msg => ({ body: msg })))
          .catch(err => {
            console.error('Queue failed, direct write:', err);
            return db.trackBatch(queueMessages);
          })
      );
    } else if (writeOps) {
      for (const op of writeOps) ctx.waitUntil(op);
    }

    return response;
  },

  async queue(batch, env) {
    const db = new D1Adapter(env.DB);
    try {
      await db.trackBatch(batch.messages.map(m => m.body));
      batch.ackAll();
    } catch {
      batch.retryAll();
    }
  },
};
