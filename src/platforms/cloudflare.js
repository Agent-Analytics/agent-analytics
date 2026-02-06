/**
 * Cloudflare Worker entry point
 * 
 * Wires up the D1 adapter and uses ctx.waitUntil() for
 * non-blocking write operations (track, batch).
 */

import { D1Adapter } from '../db/d1.js';
import { handleRequest } from '../handlers.js';

export default {
  async fetch(request, env, ctx) {
    const db = new D1Adapter(env.DB);
    const { response, writeOps } = await handleRequest(request, db, env.API_KEYS, {
      projectTokens: env.PROJECT_TOKENS,
    });

    // Fire-and-forget writes — response is already sent
    if (writeOps) {
      for (const op of writeOps) {
        ctx.waitUntil(op);
      }
    }

    return response;
  },
};
