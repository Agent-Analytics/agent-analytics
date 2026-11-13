/**
 * OSS request handler. Core serves the existing routes. POST /sql is added
 * here because the read-only execution path differs by platform.
 */

import { createAnalyticsHandler } from '@agent-analytics/core';
import { handleSqlRequest } from './sql/route.js';

export function createOssHandler({ db, validateWrite, validateRead, allowedOrigins, executeSql }) {
  const handleRequest = createAnalyticsHandler({
    db,
    validateWrite,
    validateRead,
    allowedOrigins,
  });

  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/sql') {
      const response = await handleSqlRequest(request, { validateRead, executeSql });
      return { response };
    }
    return handleRequest(request);
  };
}
