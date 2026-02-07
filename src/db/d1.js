/**
 * Cloudflare D1 database adapter
 * 
 * Wraps D1 bindings with the standard adapter interface.
 * All SQL queries live here — handlers never touch SQL directly.
 */

import { today, daysAgo } from './adapter.js';

export function validatePropertyKey(key) {
  if (!key || key.length > 128 || !/^[a-zA-Z0-9_]+$/.test(key)) {
    throw new Error('Invalid property filter key');
  }
}

export class D1Adapter {
  constructor(db) {
    /** @type {import('@cloudflare/workers-types').D1Database} */
    this.db = db;
  }

  /**
   * Insert a single event. Returns a Promise (caller decides blocking vs waitUntil).
   */
  trackEvent({ project, event, properties, user_id, timestamp }) {
    const ts = timestamp || Date.now();
    const date = new Date(ts).toISOString().split('T')[0];
    return this.db.prepare(
      `INSERT INTO events (project_id, event, properties, user_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      project,
      event,
      properties ? JSON.stringify(properties) : null,
      user_id || null,
      ts,
      date
    ).run();
  }

  /**
   * Batch insert events. Returns a Promise.
   */
  trackBatch(events) {
    const stmt = this.db.prepare(
      `INSERT INTO events (project_id, event, properties, user_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const batch = events.map(e => {
      const ts = e.timestamp || Date.now();
      const date = new Date(ts).toISOString().split('T')[0];
      return stmt.bind(
        e.project,
        e.event,
        e.properties ? JSON.stringify(e.properties) : null,
        e.user_id || null,
        ts,
        date
      );
    });
    return this.db.batch(batch);
  }

  /**
   * Aggregated stats: daily breakdown, event counts, totals.
   */
  async getStats({ project, days = 7 }) {
    const fromDate = daysAgo(days);

    const [dailyUsers, eventCounts, totals] = await Promise.all([
      this.db.prepare(
        `SELECT date, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY date ORDER BY date`
      ).bind(project, fromDate).all(),

      this.db.prepare(
        `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY event ORDER BY count DESC LIMIT 20`
      ).bind(project, fromDate).all(),

      this.db.prepare(
        `SELECT COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
         FROM events WHERE project_id = ? AND date >= ?`
      ).bind(project, fromDate).first(),
    ]);

    return {
      period: { from: fromDate, to: today(), days },
      totals,
      daily: dailyUsers.results,
      events: eventCounts.results,
    };
  }

  /**
   * Raw events query with optional event filter.
   */
  async getEvents({ project, event, days = 7, limit = 100 }) {
    const fromDate = daysAgo(days);
    const safeLimit = Math.min(limit, 1000);

    let query = `SELECT * FROM events WHERE project_id = ? AND date >= ?`;
    const params = [project, fromDate];

    if (event) {
      query += ` AND event = ?`;
      params.push(event);
    }

    query += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(safeLimit);

    const result = await this.db.prepare(query).bind(...params).all();

    return result.results.map(e => ({
      ...e,
      properties: e.properties ? JSON.parse(e.properties) : null,
    }));
  }

  /**
   * Flexible analytics query with metrics, filters, grouping.
   */
  async query({ project, metrics = ['event_count'], filters, date_from, date_to, group_by = [], order_by, order, limit = 100 }) {
    const ALLOWED_METRICS = ['event_count', 'unique_users'];
    const ALLOWED_GROUP_BY = ['event', 'date', 'user_id'];

    for (const m of metrics) {
      if (!ALLOWED_METRICS.includes(m)) throw new Error(`invalid metric: ${m}. allowed: ${ALLOWED_METRICS.join(', ')}`);
    }
    for (const g of group_by) {
      if (!ALLOWED_GROUP_BY.includes(g)) throw new Error(`invalid group_by: ${g}. allowed: ${ALLOWED_GROUP_BY.join(', ')}`);
    }

    // SELECT
    const selectParts = [...group_by];
    for (const m of metrics) {
      if (m === 'event_count') selectParts.push('COUNT(*) as event_count');
      if (m === 'unique_users') selectParts.push('COUNT(DISTINCT user_id) as unique_users');
    }
    if (selectParts.length === 0) selectParts.push('COUNT(*) as event_count');

    // WHERE
    const fromDate = date_from || daysAgo(7);
    const toDate = date_to || today();
    const whereParts = ['project_id = ?', 'date >= ?', 'date <= ?'];
    const params = [project, fromDate, toDate];

    // Filters
    if (filters && Array.isArray(filters)) {
      const FILTER_OPS = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };
      const FILTERABLE_FIELDS = ['event', 'user_id', 'date'];

      for (const f of filters) {
        if (!f.field || !f.op || f.value === undefined) continue;
        const sqlOp = FILTER_OPS[f.op];
        if (!sqlOp) throw new Error(`invalid filter op: ${f.op}. allowed: ${Object.keys(FILTER_OPS).join(', ')}`);

        if (FILTERABLE_FIELDS.includes(f.field)) {
          whereParts.push(`${f.field} ${sqlOp} ?`);
          params.push(f.value);
        } else if (f.field.startsWith('properties.')) {
          const propKey = f.field.replace('properties.', '');
          validatePropertyKey(propKey);
          whereParts.push(`json_extract(properties, '$.${propKey}') ${sqlOp} ?`);
          params.push(f.value);
        }
      }
    }

    let sql = `SELECT ${selectParts.join(', ')} FROM events WHERE ${whereParts.join(' AND ')}`;

    if (group_by.length > 0) sql += ` GROUP BY ${group_by.join(', ')}`;

    // ORDER
    const ALLOWED_ORDER = ['event_count', 'unique_users', 'date', 'event'];
    const orderField = order_by && ALLOWED_ORDER.includes(order_by) ? order_by : (group_by.includes('date') ? 'date' : 'event_count');
    const orderDir = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${orderField} ${orderDir}`;

    const maxLimit = Math.min(limit, 1000);
    sql += ` LIMIT ?`;
    params.push(maxLimit);

    const result = await this.db.prepare(sql).bind(...params).all();

    return {
      period: { from: fromDate, to: toDate },
      metrics,
      group_by,
      rows: result.results,
      count: result.results.length,
    };
  }

  /**
   * Discover event names and property keys for a project.
   */
  async getProperties({ project, days = 30 }) {
    const fromDate = daysAgo(days);

    const [events, sample] = await Promise.all([
      this.db.prepare(
        `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users,
                MIN(date) as first_seen, MAX(date) as last_seen
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY event ORDER BY count DESC`
      ).bind(project, fromDate).all(),

      this.db.prepare(
        `SELECT DISTINCT properties FROM events 
         WHERE project_id = ? AND properties IS NOT NULL AND date >= ?
         ORDER BY timestamp DESC LIMIT 100`
      ).bind(project, fromDate).all(),
    ]);

    const propKeys = new Set();
    for (const row of sample.results) {
      try {
        const props = JSON.parse(row.properties);
        Object.keys(props).forEach(k => propKeys.add(k));
      } catch (e) { /* skip malformed JSON */ }
    }

    return {
      events: events.results,
      property_keys: [...propKeys].sort(),
    };
  }
}
