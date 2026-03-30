/**
 * better-sqlite3 adapter for self-hosted Node.js deployments.
 *
 * Thin subclass of BaseAdapter — implements the 4 DB primitives
 * using better-sqlite3's synchronous .prepare().run()/.all()/.get() API.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseAdapter } from '@agent-analytics/core/base-adapter';
import { ulid } from '@agent-analytics/core/ulid';
import {
  buildEventInsertStatement,
  buildIdentifyStatements,
  buildSessionUpsertStatement,
} from './identity-aware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SqliteAdapter extends BaseAdapter {
  constructor(dbPath = 'analytics.db') {
    super();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
  }

  _initSchema() {
    const schemaPath = resolve(__dirname, '../../schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
    this._migrateLegacySchema();
  }

  _migrateLegacySchema() {
    const eventColumns = this.db.prepare('PRAGMA table_info(events)').all();
    if (eventColumns.length > 0 && !eventColumns.some((column) => column.name === 'country')) {
      this.db.exec('ALTER TABLE events ADD COLUMN country TEXT');
    }
  }

  _run(sql, params) {
    return this.db.prepare(sql).run(...params);
  }

  _queryAll(sql, params) {
    return this.db.prepare(sql).all(...params);
  }

  _queryOne(sql, params) {
    return this.db.prepare(sql).get(...params) || null;
  }

  _batch(statements) {
    const txn = this.db.transaction((stmts) => {
      for (const { sql, params } of stmts) {
        this.db.prepare(sql).run(...params);
      }
    });
    txn(statements);
  }

  _sessionUpsertSqlAndParams(project, eventData) {
    return buildSessionUpsertStatement({
      project,
      session_id: eventData.session_id,
      user_id: eventData.user_id,
      timestamp: eventData.timestamp,
      properties: eventData.properties,
      count: eventData._count || 1,
    });
  }

  async trackEvent(eventData) {
    const eventStatement = buildEventInsertStatement({
      id: ulid(),
      ...eventData,
    });

    if (!eventData.session_id) {
      return this._run(eventStatement.sql, eventStatement.params);
    }

    const sessionStatement = this._sessionUpsertSqlAndParams(eventData.project, eventData);
    return this._batch([eventStatement, sessionStatement]);
  }

  async trackBatch(events) {
    const statements = [];

    for (const event of events) {
      statements.push(buildEventInsertStatement({
        id: ulid(),
        ...event,
      }));
    }

    for (const event of events) {
      if (!event.session_id) continue;
      statements.push(this._sessionUpsertSqlAndParams(event.project, event));
    }

    return this._batch(statements);
  }

  async upsertSession(sessionData) {
    const statement = this._sessionUpsertSqlAndParams(
      sessionData.project_id || sessionData.project,
      sessionData,
    );
    return this._run(statement.sql, statement.params);
  }

  async identifyUser(identityData) {
    return this._batch(buildIdentifyStatements(identityData));
  }
}
