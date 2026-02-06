/**
 * Auth & origin validation
 *
 * Two types of keys:
 * - API_KEYS: Read access (GET /stats, /events, /properties, POST /query)
 * - WRITE_KEYS: Write access (POST /track, /track/batch)
 *
 * Origin checking:
 * - ALLOWED_ORIGINS: Comma-separated list of allowed origins for browser requests
 * - If set, browser requests without a matching Origin are rejected
 * - Server-side requests (no Origin header) must use a WRITE_KEY instead
 */

/**
 * Validate a read API key.
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
 * Validate write access for track endpoints.
 *
 * Security model:
 * - If WRITE_KEYS is set → require X-Write-Key header or ?write_key= param
 * - If ALLOWED_ORIGINS is set → browser requests must have matching Origin
 * - If neither is set → open access (dev/testing mode)
 *
 * @param {Request} request
 * @param {URL} url
 * @param {{ writeKeys?: string, allowedOrigins?: string }} opts
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateWriteAccess(request, url, opts = {}) {
  const { writeKeys, allowedOrigins } = opts;

  // Check write key first — if provided and valid, always allow
  const writeKey = request.headers.get('X-Write-Key') || url.searchParams.get('write_key');
  if (writeKey && writeKeys) {
    const keys = writeKeys.split(',').map(k => k.trim());
    if (keys.includes(writeKey)) {
      return { valid: true };
    }
    // Key provided but invalid
    return { valid: false, error: 'invalid write key' };
  }

  // If write keys are configured but none provided, check origin as fallback
  const origin = request.headers.get('Origin');

  if (allowedOrigins) {
    const allowed = allowedOrigins.split(',').map(o => o.trim().toLowerCase());

    if (origin) {
      // Browser request — validate origin
      if (!allowed.includes(origin.toLowerCase())) {
        return { valid: false, error: 'origin not allowed' };
      }
      return { valid: true };
    }

    // No origin header (server-side request) — require write key if configured
    if (writeKeys) {
      return { valid: false, error: 'write key required for server-side requests' };
    }
  }

  // If write keys configured but no key provided and no origin check passed
  if (writeKeys && !writeKey) {
    return { valid: false, error: 'write key required' };
  }

  // Neither WRITE_KEYS nor ALLOWED_ORIGINS set — open access (dev mode)
  return { valid: true };
}
