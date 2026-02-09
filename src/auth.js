/**
 * Auth validation factories for the open-source server.
 *
 * Returns validator functions matching core's expected interface:
 * - validateWrite(request, body) → { valid, error? }
 * - validateRead(request, url) → { valid }
 */

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
    const tokens = projectTokensStr.split(',').map(t => t.trim());
    if (!tokens.includes(token)) return { valid: false, error: 'invalid token' };
    return { valid: true };
  };
}

/**
 * Create a read validator for query endpoints (/stats, /events, /query, /properties).
 * API key via X-API-Key header or ?key= query param.
 */
export function makeValidateRead(apiKeysStr) {
  return function validateRead(request, url) {
    const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
    if (!apiKeysStr || !apiKey || !apiKeysStr.split(',').includes(apiKey)) {
      return { valid: false };
    }
    return { valid: true };
  };
}
