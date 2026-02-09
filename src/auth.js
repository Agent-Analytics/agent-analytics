/**
 * Auth validation factories for the open-source server.
 *
 * Returns validator functions matching core's expected interface:
 * - validateWrite(request, body) → { valid, error? }
 * - validateRead(request, url) → { valid }
 */

import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Check if value matches any item in a comma-separated list (constant-time per item). */
function includesSafe(list, value) {
  const items = list.split(',').map(t => t.trim());
  let found = false;
  for (const item of items) {
    if (safeEqual(item, value)) found = true;
  }
  return found;
}

/**
 * Create a write validator for ingestion endpoints (/track, /track/batch).
 * Token is passed in the JSON body as "token" field.
 * If no PROJECT_TOKENS are configured, ingestion is open (dev mode).
 */
export function makeValidateWrite(projectTokensStr) {
  return function validateWrite(_request, body) {
    if (!projectTokensStr) return { valid: true };
    const token = body?.token;
    if (!token) return { valid: false, error: 'token required' };
    if (!includesSafe(projectTokensStr, token)) return { valid: false, error: 'invalid token' };
    return { valid: true };
  };
}

/**
 * Create a read validator for query endpoints (/stats, /events, /query, /properties).
 * API key via X-API-Key header or ?key= query param.
 */
export function makeValidateRead(apiKeysStr) {
  return function validateRead(request, url) {
    let apiKey = request.headers.get('X-API-Key');
    if (!apiKey && url.searchParams.get('key')) {
      apiKey = url.searchParams.get('key');
      console.warn('Deprecation: API key passed via ?key= query param. Use X-API-Key header instead to avoid key leakage in logs and referrer headers.');
    }
    if (!apiKeysStr || !apiKey || !includesSafe(apiKeysStr, apiKey)) {
      return { valid: false };
    }
    return { valid: true };
  };
}
