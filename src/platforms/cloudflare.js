/**
 * Cloudflare Worker entry point (open-source, single-tenant)
 *
 * Uses core's D1Adapter and the OSS handler for a simple self-hosted
 * Cloudflare Workers deployment with a single D1 database.
 *
 * POST /sql runs the shared parser, then executes on this D1 binding.
 * The binding can write. Workers has no read-only D1 connection, so a parser
 * miss can modify the database. The Node server is stricter: it runs POST /sql
 * on a SQLite connection opened read-only. Treat this Workers path as weaker.
 *
 * The SQL route stops waiting after 10 seconds and returns SQL_TIMEOUT.
 * That response does not cancel the statement. The query can still finish
 * inside D1 after the Worker has already answered.
 *
 * For the multi-tenant hosted product, see hosted/entry.js.
 */

import { makeValidateWrite, makeValidateRead } from '../auth.js';
import { D1Adapter, ensureD1Compatibility } from '../db/d1.js';
import { createOssHandler } from '../oss-handler.js';
import { executeD1Sql } from '../sql/d1-execute.js';

export default {
  async fetch(request, env, ctx) {
    await ensureD1Compatibility(env.DB);
    const db = new D1Adapter(env.DB);
    const validateWrite = makeValidateWrite(env.PROJECT_TOKENS);
    const validateRead = makeValidateRead(env.API_KEYS);
    const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : undefined;
    const handleRequest = createOssHandler({
      db,
      validateWrite,
      validateRead,
      allowedOrigins,
      executeSql: (prepared) => executeD1Sql(env.DB, prepared),
    });
    const { response, writeOps } = await handleRequest(request);

    if (writeOps) {
      for (const op of writeOps) {
        ctx.waitUntil(op);
      }
    }

    return response;
  },
};
