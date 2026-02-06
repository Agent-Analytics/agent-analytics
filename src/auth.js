/**
 * Auth validation
 *
 * Two auth models:
 * - Project Token: Public, embedded in client JS. Passed in request body
 *   alongside event data. Used for ingestion (/track, /track/batch).
 *   Like Mixpanel's project token — not a secret, just identifies the project.
 *
 * - API Key: Private, server-side only. Passed via X-API-Key header or
 *   ?key= query param. Used for reading data (/stats, /events, /query, /properties).
 */

/**
 * Validate a read API key (for query endpoints).
 * @param {Request} request
 * @param {URL} url
 * @param {string} apiKeysStr - Comma-separated allowed read keys
 * @returns {{ valid: boolean }}
 */
export function validateApiKey(request, url, apiKeysStr) {
  const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
  if (!apiKeysStr || !apiKey || !apiKeysStr.split(',').includes(apiKey)) {
    return { valid: false };
  }
  return { valid: true };
}

/**
 * Validate a project token from the request body (for ingestion endpoints).
 * Token is passed in the JSON body as "token" field.
 * If no PROJECT_TOKENS are configured, ingestion is open (dev mode).
 *
 * @param {string} bodyToken - Token from the request body
 * @param {string} projectTokensStr - Comma-separated valid project tokens (from env)
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateProjectToken(bodyToken, projectTokensStr) {
  // No tokens configured — open access (dev/self-host mode)
  if (!projectTokensStr) {
    return { valid: true };
  }

  if (!bodyToken) {
    return { valid: false, error: 'token required' };
  }

  const tokens = projectTokensStr.split(',').map(t => t.trim());
  if (!tokens.includes(bodyToken)) {
    return { valid: false, error: 'invalid token' };
  }

  return { valid: true };
}
