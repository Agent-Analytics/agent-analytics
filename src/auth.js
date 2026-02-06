/**
 * Auth validation — multi-tenant
 *
 * Two auth models:
 * - Project Token (aat_xxx): Public, embedded in client JS. Passed in request body.
 *   Used for ingestion (/track, /track/batch). Like Mixpanel's project token.
 *
 * - API Key (aak_xxx): Private, server-side only. Passed via X-API-Key header or
 *   ?key= query param. Used for reading data (/stats, /events, /query, /properties).
 *
 * Multi-tenant: tokens/keys are looked up from the projects table in D1.
 * Legacy: env-var based auth still works as fallback (self-hosted mode).
 */

/**
 * Generate a cryptographically random token with prefix.
 * @param {string} prefix - e.g. 'aat' or 'aak'
 * @returns {string}
 */
export function generateToken(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

/**
 * Generate a UUID v4.
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * Validate a read API key (for query endpoints).
 * Checks DB first (multi-tenant), then falls back to env var (self-hosted).
 *
 * @param {Request} request
 * @param {URL} url
 * @param {string} apiKeysStr - Comma-separated allowed read keys (env fallback)
 * @param {{ projectsCache?: Map }} ctx - Optional cache
 * @returns {{ valid: boolean, projectId?: string }}
 */
export function validateApiKey(request, url, apiKeysStr, ctx) {
  const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
  if (!apiKey) return { valid: false };

  // Check multi-tenant cache first
  if (ctx && ctx.projectsCache) {
    const project = ctx.projectsCache.get(`aak:${apiKey}`);
    if (project) return { valid: true, projectId: project.id, project };
  }

  // Fallback to env var (self-hosted / legacy)
  if (apiKeysStr && apiKeysStr.split(',').includes(apiKey)) {
    return { valid: true };
  }

  return { valid: false };
}

/**
 * Validate a project token from the request body (for ingestion).
 * Checks DB first, then env var fallback.
 *
 * @param {string} bodyToken
 * @param {string} projectTokensStr - Env var fallback
 * @param {{ projectsCache?: Map }} ctx
 * @returns {{ valid: boolean, error?: string, projectId?: string }}
 */
export function validateProjectToken(bodyToken, projectTokensStr, ctx) {
  // Check multi-tenant cache first
  if (ctx && ctx.projectsCache && bodyToken) {
    const project = ctx.projectsCache.get(`aat:${bodyToken}`);
    if (project) return { valid: true, projectId: project.id, project };
  }

  // No tokens configured anywhere — open access (dev mode)
  if (!projectTokensStr && !(ctx && ctx.projectsCache && ctx.projectsCache.size > 0)) {
    return { valid: true };
  }

  if (!bodyToken) {
    return { valid: false, error: 'token required' };
  }

  // Env var fallback
  if (projectTokensStr) {
    const tokens = projectTokensStr.split(',').map(t => t.trim());
    if (tokens.includes(bodyToken)) return { valid: true };
  }

  return { valid: false, error: 'invalid token' };
}
