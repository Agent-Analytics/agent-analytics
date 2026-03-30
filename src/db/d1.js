import { D1Adapter as CoreD1Adapter } from '@agent-analytics/core';
import { ulid } from '@agent-analytics/core/ulid';
import {
  buildEventInsertStatement,
  buildIdentifyStatements,
  buildSessionUpsertStatement,
} from './identity-aware.js';

const schemaCompatibility = new WeakMap();

export function ensureD1Compatibility(db) {
  let pending = schemaCompatibility.get(db);
  if (pending) return pending;

  pending = (async () => {
    const eventColumns = await db.prepare('PRAGMA table_info(events)').all();
    const hasCountry = eventColumns.results.some((column) => column.name === 'country');

    if (eventColumns.results.length > 0 && !hasCountry) {
      await db.prepare('ALTER TABLE events ADD COLUMN country TEXT').run();
    }

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS identity_map (
        previous_id TEXT NOT NULL,
        canonical_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (previous_id, project_id)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_identity_canonical ON identity_map(canonical_id, project_id)').run();
  })().catch((error) => {
    schemaCompatibility.delete(db);
    throw error;
  });

  schemaCompatibility.set(db, pending);
  return pending;
}

export class D1Adapter extends CoreD1Adapter {
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
