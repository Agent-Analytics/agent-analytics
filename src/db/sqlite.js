/**
 * better-sqlite3 adapter for self-hosted Node.js deployments
 *
 * Implements the same interface as core's D1Adapter but uses
 * synchronous better-sqlite3 calls wrapped in async methods.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { today, parseSince, parseSinceMs, validatePropertyKey } from '@agent-analytics/core';
import { ulid } from '@agent-analytics/core/ulid';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SqliteAdapter {
  constructor(dbPath = 'analytics.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
  }

  _initSchema() {
    const schemaPath = resolve(__dirname, '../../schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  /** Run the session upsert for a given event (synchronous). */
  _upsertSession(project, event_data) {
    const ts = event_data.timestamp || Date.now();
    const date = new Date(ts).toISOString().split('T')[0];
    const page = (event_data.properties && typeof event_data.properties === 'object')
      ? (event_data.properties.path || event_data.properties.url || null)
      : null;
    const count = event_data._count || 1;
    this.db.prepare(
      `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         start_time = MIN(sessions.start_time, excluded.start_time),
         end_time = MAX(sessions.end_time, excluded.end_time),
         duration = MAX(sessions.end_time, excluded.end_time) - MIN(sessions.start_time, excluded.start_time),
         entry_page = CASE WHEN excluded.start_time < sessions.start_time THEN excluded.entry_page ELSE sessions.entry_page END,
         exit_page = CASE WHEN excluded.end_time >= sessions.end_time THEN excluded.exit_page ELSE sessions.exit_page END,
         event_count = sessions.event_count + excluded.event_count,
         is_bounce = CASE WHEN sessions.event_count + excluded.event_count > 1 THEN 0 ELSE 1 END`
    ).run(
      event_data.session_id,
      event_data.user_id || null,
      project,
      ts, ts,
      page, page,
      count,
      date
    );
  }

  async trackEvent({ project, event, properties, user_id, session_id, timestamp }) {
    const ts = timestamp || Date.now();
    const date = new Date(ts).toISOString().split('T')[0];

    if (!session_id) {
      this.db.prepare(
        `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ulid(), project, event,
        properties ? JSON.stringify(properties) : null,
        user_id || null, null, ts, date
      );
      return;
    }

    const txn = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ulid(), project, event,
        properties ? JSON.stringify(properties) : null,
        user_id || null, session_id, ts, date
      );
      this._upsertSession(project, { session_id, user_id, timestamp: ts, properties });
    });
    txn();
  }

  async trackBatch(events) {
    const insertEvent = this.db.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const txn = this.db.transaction((evts) => {
      for (const e of evts) {
        const ts = e.timestamp || Date.now();
        const date = new Date(ts).toISOString().split('T')[0];
        insertEvent.run(
          ulid(), e.project, e.event,
          e.properties ? JSON.stringify(e.properties) : null,
          e.user_id || null, e.session_id || null, ts, date
        );
      }
      for (const e of evts) {
        if (!e.session_id) continue;
        const ts = e.timestamp || Date.now();
        this._upsertSession(e.project, {
          session_id: e.session_id,
          user_id: e.user_id,
          timestamp: ts,
          properties: e.properties,
        });
      }
    });
    txn(events);
  }

  async upsertSession(sessionData) {
    this._upsertSession(sessionData.project_id || sessionData.project, sessionData);
  }

  async getSessions({ project, since, user_id, is_bounce, limit = 100 }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(limit, 1000);

    let query = `SELECT * FROM sessions WHERE project_id = ? AND date >= ?`;
    const params = [project, fromDate];

    if (user_id) {
      query += ` AND user_id = ?`;
      params.push(user_id);
    }
    if (is_bounce !== undefined && is_bounce !== null) {
      query += ` AND is_bounce = ?`;
      params.push(Number(is_bounce));
    }

    query += ` ORDER BY start_time DESC LIMIT ?`;
    params.push(safeLimit);

    return this.db.prepare(query).all(...params);
  }

  async getSessionStats({ project, since }) {
    const fromDate = parseSince(since);
    const row = this.db.prepare(
      `SELECT COUNT(*) as total_sessions,
              SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounced_sessions,
              SUM(duration) as total_duration,
              SUM(event_count) as total_events,
              COUNT(DISTINCT user_id) as unique_users
       FROM sessions WHERE project_id = ? AND date >= ?`
    ).get(project, fromDate);

    const total = row?.total_sessions || 0;
    if (total === 0) {
      return { total_sessions: 0, bounce_rate: 0, avg_duration: 0, pages_per_session: 0, sessions_per_user: 0 };
    }

    const uniqueUsers = row.unique_users || 1;
    return {
      total_sessions: total,
      bounce_rate: (row.bounced_sessions || 0) / total,
      avg_duration: Math.round((row.total_duration || 0) / total),
      pages_per_session: Math.round(((row.total_events || 0) / total) * 10) / 10,
      sessions_per_user: Math.round((total / uniqueUsers) * 10) / 10,
    };
  }

  async cleanupSessions({ project, before_date }) {
    return this.db.prepare(
      `DELETE FROM sessions WHERE project_id = ? AND date < ?`
    ).run(project, before_date);
  }

  async getStats({ project, since, groupBy = 'day' }) {
    const fromDate = parseSince(since);
    const fromMs = parseSinceMs(since);
    const VALID_GROUP = ['hour', 'day', 'week', 'month'];
    if (!VALID_GROUP.includes(groupBy)) groupBy = 'day';

    let bucketExpr;
    if (groupBy === 'hour') {
      bucketExpr = `strftime('%Y-%m-%dT%H:00', timestamp / 1000, 'unixepoch')`;
    } else if (groupBy === 'week') {
      bucketExpr = `date(date, 'weekday 0', '-6 days')`;
    } else if (groupBy === 'month') {
      bucketExpr = `strftime('%Y-%m', date)`;
    } else {
      bucketExpr = `date`;
    }

    const bindVal = groupBy === 'hour' ? fromMs : fromDate;
    const dateCol = groupBy === 'hour' ? 'timestamp' : 'date';

    const timeSeries = this.db.prepare(
      `SELECT ${bucketExpr} as bucket, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
       FROM events WHERE project_id = ? AND ${dateCol} >= ?
       GROUP BY bucket ORDER BY bucket`
    ).all(project, bindVal);

    const eventCounts = this.db.prepare(
      `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
       FROM events WHERE project_id = ? AND date >= ?
       GROUP BY event ORDER BY count DESC LIMIT 20`
    ).all(project, fromDate);

    const totals = this.db.prepare(
      `SELECT COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
       FROM events WHERE project_id = ? AND date >= ?`
    ).get(project, fromDate);

    const sessions = await this.getSessionStats({ project, since });

    return {
      period: { from: fromDate, to: today(), groupBy },
      totals,
      timeSeries,
      events: eventCounts,
      sessions,
    };
  }

  async getEvents({ project, event, session_id, since, limit = 100 }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(limit, 1000);

    let query = `SELECT * FROM events WHERE project_id = ? AND date >= ?`;
    const params = [project, fromDate];

    if (event) {
      query += ` AND event = ?`;
      params.push(event);
    }
    if (session_id) {
      query += ` AND session_id = ?`;
      params.push(session_id);
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
    const ALLOWED_METRICS = ['event_count', 'unique_users', 'session_count', 'bounce_rate', 'avg_duration'];
    const ALLOWED_GROUP_BY = ['event', 'date', 'user_id', 'session_id'];

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
      if (m === 'session_count') selectParts.push('COUNT(DISTINCT session_id) as session_count');
      if (m === 'bounce_rate') selectParts.push('COUNT(DISTINCT session_id) as _session_count_for_bounce');
      if (m === 'avg_duration') selectParts.push('COUNT(DISTINCT session_id) as _session_count_for_duration');
    }
    if (selectParts.length === 0) selectParts.push('COUNT(*) as event_count');

    const fromDate = date_from || parseSince(null);
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
          validatePropertyKey(propKey);
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

  async listProjects() {
    return this.db.prepare(
      `SELECT project_id as id, MIN(date) as created, MAX(date) as last_active, COUNT(*) as event_count
       FROM events GROUP BY project_id ORDER BY last_active DESC`
    ).all();
  }

  async getProperties({ project, since }) {
    const fromDate = parseSince(since);

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
      } catch { /* skip malformed JSON */ }
    }

    return {
      events,
      property_keys: [...propKeys].sort(),
    };
  }
}
