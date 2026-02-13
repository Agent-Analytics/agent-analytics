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
}
