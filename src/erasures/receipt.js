/**
 * erasure_requests rows and the public receipt. No raw subject is written.
 */

import { ulid } from '@agent-analytics/core/ulid';
import { sha256Hex } from './hash.js';

export const ERASURE_ACCOUNT_ID = 'oss';
export const ERASURE_REQUESTED_BY = 'api_key';
export const ERASURE_LIST_LIMIT = 100;
export const AUDIT_RETENTION_MS = 24 * 365 * 24 * 60 * 60 * 1000;

const COUNT_KEYS = [
  'events',
  'sessions',
  'identity_rows',
  'profiles',
  'email_lookups',
  'replay_sessions',
  'replay_objects',
];

export function emptyCounts() {
  return {
    events: 0,
    sessions: 0,
    identity_rows: 0,
    profiles: 0,
    email_lookups: 0,
    replay_sessions: 0,
    replay_objects: 0,
  };
}

export function normalizeCounts(value) {
  const source = value && typeof value === 'object' ? value : {};
  const counts = {};
  for (const key of COUNT_KEYS) {
    const number = Number(source[key]);
    counts[key] = Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }
  return counts;
}

export function addCounts(left, right) {
  const a = normalizeCounts(left);
  const b = normalizeCounts(right);
  const counts = {};
  for (const key of COUNT_KEYS) counts[key] = a[key] + b[key];
  return counts;
}

export function toReceipt(row) {
  let parsed = {};
  if (row.counts_json) {
    try {
      parsed = JSON.parse(row.counts_json);
    } catch {
      parsed = {};
    }
  }

  const receipt = {
    id: row.id,
    status: row.status,
    project: row.project_name,
    subject_type: row.subject_type,
    counts: normalizeCounts(parsed),
    replay_included: row.replay_included === 1 || row.replay_included === true,
  };

  if (row.completed_at) receipt.completed_at = new Date(Number(row.completed_at)).toISOString();
  if (row.error) receipt.error = row.error;
  return receipt;
}

export function newErasureId() {
  return `era_${ulid()}`;
}

export async function pruneExpiredReceipts(db, now = Date.now()) {
  await db._run(
    'DELETE FROM erasure_requests WHERE created_at < ?',
    [now - AUDIT_RETENTION_MS],
  );
}

export async function findErasureByKey(db, idempotencyKey) {
  const keyHash = await sha256Hex(idempotencyKey);
  return db._queryOne(
    `SELECT * FROM erasure_requests WHERE account_id = ? AND idempotency_key_hash = ?`,
    [ERASURE_ACCOUNT_ID, keyHash],
  );
}

export async function findErasureById(db, id) {
  return db._queryOne(
    'SELECT * FROM erasure_requests WHERE id = ?',
    [id],
  );
}

export async function listErasuresForProject(db, project) {
  return db._queryAll(
    `SELECT * FROM erasure_requests
     WHERE project_name = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ${ERASURE_LIST_LIMIT}`,
    [project],
  );
}

export async function insertRunningErasure(db, row) {
  await db._run(
    `INSERT INTO erasure_requests (
       id, account_id, project_id, project_name, idempotency_key_hash,
       subject_type, subject_hash, status, counts_json, error,
       created_at, started_at, completed_at, requested_by, body_hash, replay_included
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?, NULL, ?, ?, ?)`,
    [
      row.id,
      ERASURE_ACCOUNT_ID,
      row.project,
      row.project,
      await sha256Hex(row.idempotencyKey),
      row.subjectType,
      row.subjectHash,
      JSON.stringify(emptyCounts()),
      row.createdAt,
      row.createdAt,
      ERASURE_REQUESTED_BY,
      row.bodyHash,
      row.includeReplays ? 1 : 0,
    ],
  );
}

export async function finishErasure(db, { id, project, status, counts, error, completedAt }) {
  await db._run(
    `UPDATE erasure_requests
     SET status = ?, counts_json = ?, error = ?, completed_at = ?
     WHERE id = ? AND project_name = ?`,
    [
      status,
      JSON.stringify(normalizeCounts(counts)),
      error,
      completedAt,
      id,
      project,
    ],
  );
}

export function isUniqueConstraint(error) {
  const code = String(error?.code || '');
  if (code.includes('CONSTRAINT')) return true;
  return /unique constraint/i.test(String(error?.message || ''));
}
