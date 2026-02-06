/**
 * Database adapter interface
 * 
 * All adapters must implement these methods. SQL lives here,
 * not in the handlers. Handlers call semantic methods like
 * db.trackEvent(), db.getStats(), etc.
 */

// Shared date helpers
export function today() {
  return new Date().toISOString().split('T')[0];
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

/**
 * @typedef {Object} DbAdapter
 * @property {function} trackEvent - Insert a single event
 * @property {function} trackBatch - Insert multiple events
 * @property {function} getStats - Aggregated stats for a project
 * @property {function} getEvents - Raw event query
 * @property {function} query - Flexible analytics query
 * @property {function} getProperties - Discover event names and property keys
 */
