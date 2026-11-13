/**
 * Synchronous subject delete for the OSS schema.
 *
 * SQL lives in @agent-analytics/core (eraseSubjectRows). includeHostedIdentity
 * stays false: this server has identity_map only, and no email lookup index.
 * An email subject therefore resolves to no user ids. Replay objects are not
 * stored. The executor reports changes at the top level because the helper
 * reads result.changes, while D1 puts that number on meta.changes.
 */

import {
  ERASURE_LARGE_EVENT_THRESHOLD,
  countSubjectEvents as countRows,
  eraseSubjectRows as eraseRows,
} from '@agent-analytics/core/erasure';

export { ERASURE_LARGE_EVENT_THRESHOLD };

export function erasureExecutor(db) {
  return {
    async queryAll(sql, params = []) {
      const rows = await db._queryAll(sql, params);
      return Array.isArray(rows) ? rows : [];
    },
    async queryOne(sql, params = []) {
      return (await db._queryOne(sql, params)) ?? null;
    },
    async run(sql, params = []) {
      const result = await db._run(sql, params);
      const reported = result?.changes ?? result?.meta?.changes;
      const changes = Number(reported);
      return { changes: Number.isFinite(changes) ? changes : 0 };
    },
  };
}

export async function countSubjectEvents(db, project, subjectType, subject) {
  if (subjectType === 'email') return 0;
  const executor = erasureExecutor(db);
  if (subjectType === 'session_id') {
    return countRows(executor, {
      project,
      sessionId: subject,
      includeHostedIdentity: false,
    });
  }
  return countRows(executor, {
    project,
    userIds: [subject],
    includeHostedIdentity: false,
  });
}

export async function projectHasRows(db, project) {
  const tables = ['events', 'sessions', 'identity_map'];
  for (const table of tables) {
    const row = await db._queryOne(
      `SELECT 1 AS present FROM ${table} WHERE project_id = ? LIMIT 1`,
      [project],
    );
    if (row) return true;
  }
  return false;
}

export async function deleteSubjectRows(db, { project, subjectType, subject }) {
  const executor = erasureExecutor(db);
  if (subjectType === 'session_id') {
    const erased = await eraseRows(executor, {
      project,
      mode: 'session_id',
      sessionId: subject,
      includeHostedIdentity: false,
    });
    return erased.counts;
  }

  // Email has no lookup index on this server, so the helper receives no user ids.
  const erased = await eraseRows(executor, {
    project,
    mode: 'user_ids',
    userIds: subjectType === 'email' ? [] : [subject],
    includeHostedIdentity: false,
  });
  return erased.counts;
}
