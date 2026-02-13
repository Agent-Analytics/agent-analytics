/**
 * Node.js HTTP server entry point
 *
 * Self-hosted alternative to Cloudflare Workers.
 * Uses better-sqlite3 for storage and Node's built-in HTTP server.
 *
 * Usage:
 *   API_KEYS=your-key PROJECT_TOKENS=pt_token node src/platforms/node.js
 *   PORT=8787 DB_PATH=./data.db API_KEYS=key1,key2 node src/platforms/node.js
 */

import { createServer } from 'node:http';
import { createAnalyticsHandler, MAX_BODY_BYTES } from '@agent-analytics/core';
import { SqliteAdapter } from '../db/sqlite.js';
import { makeValidateWrite, makeValidateRead } from '../auth.js';

const PORT = parseInt(process.env.PORT || '8787');
const API_KEYS = process.env.API_KEYS || '';
const PROJECT_TOKENS = process.env.PROJECT_TOKENS || '';
const DB_PATH = process.env.DB_PATH || 'analytics.db';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '';

const db = new SqliteAdapter(DB_PATH);

const handleRequest = createAnalyticsHandler({
  db,
  validateWrite: makeValidateWrite(PROJECT_TOKENS),
  validateRead: makeValidateRead(API_KEYS),
  allowedOrigins: ALLOWED_ORIGINS ? ALLOWED_ORIGINS.split(',').map(o => o.trim()) : undefined,
});

const server = createServer(async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url, `${protocol}://${host}`);

    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'request body too large' }));
          return;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString();
    }

    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body,
    });

    const { response, writeOps } = await handleRequest(request);

    if (writeOps) {
      for (const op of writeOps) {
        op.catch(err => console.error('Write error:', err));
      }
    }

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const text = await response.text();
    res.end(text);
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Agent Analytics running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
