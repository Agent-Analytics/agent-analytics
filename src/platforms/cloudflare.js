/**
 * Cloudflare Worker entry point
 * 
 * Two modes depending on config:
 * 
 * 1. WITH Queue (recommended for production):
 *    fetch() enqueues events → queue() batch-writes to D1
 *    Benefits: true non-blocking, automatic batching, retries
 * 
 * 2. WITHOUT Queue (simpler setup):
 *    fetch() writes directly via ctx.waitUntil()
 *    Works fine for low-medium traffic
 */

import { D1Adapter } from '../db/d1.js';
import { handleRequest } from '../handlers.js';

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);
    const queue = env.ANALYTICS_QUEUE || null;

    const { response, writeOps, queueMessages } = await handleRequest(request, db, env.API_KEYS, {
      projectTokens: env.PROJECT_TOKENS,
      useQueue: !!queue,
    });

    if (queue && queueMessages && queueMessages.length > 0) {
      // Enqueue for async processing — instant response to client
      // If enqueue fails, fall back to direct write
      ctx.waitUntil(
        queue.sendBatch(queueMessages.map(msg => ({ body: msg })))
          .catch(err => {
            console.error('Queue enqueue failed, falling back to direct write:', err);
            return db.trackBatch(queueMessages);
          })
          .catch(err => console.error('Direct write fallback also failed:', err))
      );
    } else if (writeOps) {
      // Direct write (no queue configured) — still non-blocking via waitUntil
      for (const op of writeOps) {
        ctx.waitUntil(op);
      }
    }

    return response;
  },

  /**
   * Queue consumer — receives batched events and writes to D1.
   * Cloudflare automatically batches messages (up to 100 per invocation).
   */
  async queue(batch, env) {
    const db = new D1Adapter(env.DB);
    const events = batch.messages.map(msg => msg.body);

    try {
      await db.trackBatch(events);
      // Ack all messages on success
      batch.ackAll();
    } catch (err) {
      console.error('Queue batch write failed:', err);
      // Retry all messages
      batch.retryAll();
    }
  },
};
