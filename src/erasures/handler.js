/**
 * OSS request wrapper. Core serves analytics routes. Erasure is handled here
 * because it runs synchronously on the single SQLite or D1 database.
 */

import { handleErasureRequest } from './route.js';

export function createErasureHandler(inner, options) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method !== 'OPTIONS' && (url.pathname === '/erasures' || url.pathname.startsWith('/erasures/'))) {
      const response = await handleErasureRequest(request, options);
      return { response };
    }
    return inner(request);
  };
}
