/**
 * API key validation
 * Keys are stored as a comma-separated string in the environment.
 */

/**
 * Validate an API key against the allowed keys list.
 * @param {Request} request - Web API Request
 * @param {URL} url - Parsed URL
 * @param {string} apiKeysStr - Comma-separated allowed keys (from env)
 * @returns {{ valid: boolean, response?: Response }}
 */
export function validateApiKey(request, url, apiKeysStr) {
  const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
  if (!apiKeysStr || !apiKey || !apiKeysStr.split(',').includes(apiKey)) {
    return { valid: false };
  }
  return { valid: true };
}
