/**
 * Synchronous subject delete for the OSS schema.
 *
 * SQL lives in @agent-analytics/core (eraseSubjectRows). includeHostedIdentity
 * stays false: this server has identity_map only, and no email lookup index.
 * Email subjects are rejected before this function runs. Replay objects are
 * not stored. The executor copies D1 meta.changes onto result.changes. A
 * missing count stays missing so the helper can apply its own fallback.
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
      if (Number.isFinite(changes)) return { changes };
      return {};
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
  if (subjectType === 'email') {
    throw new Error('email erasure is not supported on self-hosted because there is no email lookup');
  }

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

  const erased = await eraseRows(executor, {
    project,
    mode: 'user_ids',
    userIds: [subject],
    includeHostedIdentity: false,
  });
  return erased.counts;
}
