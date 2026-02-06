/**
 * Node.js HTTP server entry point
 * 
 * Self-hosted alternative to Cloudflare Workers.
 * Uses better-sqlite3 for storage and Node's built-in HTTP server.
 * 
 * Usage:
 *   API_KEYS=your-key node src/platforms/node.js
 *   PORT=8787 API_KEYS=key1,key2 node src/platforms/node.js
 */

import { createServer } from 'node:http';
import { SqliteAdapter } from '../db/sqlite.js';
import { handleRequest } from '../handlers.js';

const PORT = parseInt(process.env.PORT || '8787');
const API_KEYS = process.env.API_KEYS || '';
const DB_PATH = process.env.DB_PATH || 'analytics.db';

const db = new SqliteAdapter(DB_PATH);

const server = createServer(async (req, res) => {
  try {
    // Convert Node IncomingMessage → Web API Request
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url, `${protocol}://${host}`);

    // Read body for POST requests
    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks).toString();
    }

    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body,
    });

    const { response } = await handleRequest(request, db, API_KEYS);

    // Convert Web API Response → Node ServerResponse
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
