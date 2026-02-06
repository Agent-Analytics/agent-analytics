/**
 * better-sqlite3 adapter for self-hosted Node.js deployments
 * 
 * Implements the same interface as the D1 adapter but uses
 * synchronous better-sqlite3 calls wrapped in async methods.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { today, daysAgo } from './adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SqliteAdapter {
  /**
   * @param {string} dbPath - Path to the SQLite database file
   */
  constructor(dbPath = 'analytics.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
  }

  /** Run schema.sql to create tables if they don't exist */
  _initSchema() {
    const schemaPath = resolve(__dirname, '../../schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  async trackEvent({ project, event, properties, user_id, timestamp }) {
    const ts = timestamp || Date.now();
    const date = new Date(ts).toISOString().split('T')[0];
    this.db.prepare(
      `INSERT INTO events (project_id, event, properties, user_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      project,
      event,
      properties ? JSON.stringify(properties) : null,
      user_id || null,
      ts,
      date
    );
  }

  async trackBatch(events) {
    const stmt = this.db.prepare(
      `INSERT INTO events (project_id, event, properties, user_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insert = this.db.transaction((evts) => {
      for (const e of evts) {
        const ts = e.timestamp || Date.now();
        const date = new Date(ts).toISOString().split('T')[0];
        stmt.run(
          e.project,
          e.event,
          e.properties ? JSON.stringify(e.properties) : null,
          e.user_id || null,
          ts,
          date
        );
      }
    });
    insert(events);
  }

  async getStats({ project, days = 7 }) {
    const fromDate = daysAgo(days);

    const daily = this.db.prepare(
      `SELECT date, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
       FROM events WHERE project_id = ? AND date >= ?
       GROUP BY date ORDER BY date`
    ).all(project, fromDate);

    const events = this.db.prepare(
      `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
       FROM events WHERE project_id = ? AND date >= ?
       GROUP BY event ORDER BY count DESC LIMIT 20`
    ).all(project, fromDate);

    const totals = this.db.prepare(
      `SELECT COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
       FROM events WHERE project_id = ? AND date >= ?`
    ).get(project, fromDate);

    return {
      period: { from: fromDate, to: today(), days },
      totals,
      daily,
      events,
    };
  }

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

    const rows = this.db.prepare(query).all(...params);

    return rows.map(e => ({
      ...e,
      properties: e.properties ? JSON.parse(e.properties) : null,
    }));
  }

  async query({ project, metrics = ['event_count'], filters, date_from, date_to, group_by = [], order_by, order, limit = 100 }) {
    const ALLOWED_METRICS = ['event_count', 'unique_users'];
    const ALLOWED_GROUP_BY = ['event', 'date', 'user_id'];

    for (const m of metrics) {
      if (!ALLOWED_METRICS.includes(m)) throw new Error(`invalid metric: ${m}. allowed: ${ALLOWED_METRICS.join(', ')}`);
    }
    for (const g of group_by) {
      if (!ALLOWED_GROUP_BY.includes(g)) throw new Error(`invalid group_by: ${g}. allowed: ${ALLOWED_GROUP_BY.join(', ')}`);
    }

    const selectParts = [...group_by];
    for (const m of metrics) {
      if (m === 'event_count') selectParts.push('COUNT(*) as event_count');
      if (m === 'unique_users') selectParts.push('COUNT(DISTINCT user_id) as unique_users');
    }
    if (selectParts.length === 0) selectParts.push('COUNT(*) as event_count');

    const fromDate = date_from || daysAgo(7);
    const toDate = date_to || today();
    const whereParts = ['project_id = ?', 'date >= ?', 'date <= ?'];
    const params = [project, fromDate, toDate];

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
          whereParts.push(`json_extract(properties, '$.${propKey}') ${sqlOp} ?`);
          params.push(f.value);
        }
      }
    }

    let sql = `SELECT ${selectParts.join(', ')} FROM events WHERE ${whereParts.join(' AND ')}`;
    if (group_by.length > 0) sql += ` GROUP BY ${group_by.join(', ')}`;

    const ALLOWED_ORDER = ['event_count', 'unique_users', 'date', 'event'];
    const orderField = order_by && ALLOWED_ORDER.includes(order_by) ? order_by : (group_by.includes('date') ? 'date' : 'event_count');
    const orderDir = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${orderField} ${orderDir}`;

    const maxLimit = Math.min(limit, 1000);
    sql += ` LIMIT ?`;
    params.push(maxLimit);

    const rows = this.db.prepare(sql).all(...params);

    return {
      period: { from: fromDate, to: toDate },
      metrics,
      group_by,
      rows,
      count: rows.length,
    };
  }

  async getProperties({ project, days = 30 }) {
    const fromDate = daysAgo(days);

    const events = this.db.prepare(
      `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users,
              MIN(date) as first_seen, MAX(date) as last_seen
       FROM events WHERE project_id = ? AND date >= ?
       GROUP BY event ORDER BY count DESC`
    ).all(project, fromDate);

    const sample = this.db.prepare(
      `SELECT DISTINCT properties FROM events 
       WHERE project_id = ? AND properties IS NOT NULL AND date >= ?
       ORDER BY timestamp DESC LIMIT 100`
    ).all(project, fromDate);

    const propKeys = new Set();
    for (const row of sample) {
      try {
        const props = JSON.parse(row.properties);
        Object.keys(props).forEach(k => propKeys.add(k));
      } catch (e) { /* skip */ }
    }

    return {
      events,
      property_keys: [...propKeys].sort(),
    };
  }
}
