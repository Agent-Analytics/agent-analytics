/**
 * POST /erasures, GET /erasures/:id, and GET /erasures?project= for OSS.
 * The read API key is the only caller. Deletes finish before the response.
 */

import { ERROR_CODES, MAX_BODY_BYTES, errorResponse } from '@agent-analytics/core';
import { erasureFingerprint } from './hash.js';
import { validateErasureBody } from './validate.js';
import { ERASURE_LARGE_EVENT_THRESHOLD, countSubjectEvents, deleteSubjectRows, projectHasRows } from './delete.js';
import {
  addCounts,
  emptyCounts,
  findErasureById,
  findErasureByKey,
  finishErasure,
  insertRunningErasure,
  isUniqueConstraint,
  listErasuresForProject,
  newErasureId,
  normalizeCounts,
  pruneExpiredReceipts,
  toReceipt,
} from './receipt.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Allow-Credentials': 'false',
};

const ERASURE_ID = /^era_[0-9A-HJKMNP-TV-Z]{26}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function erasureError(error, message, status) {
  return json({ error, message }, status);
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

async function requireRead(request, validateRead) {
  const url = new URL(request.url);
  const auth = validateRead(request, url);
  if (!auth?.valid) {
    return json(errorResponse(ERROR_CODES.AUTH_REQUIRED, 'API key required'), 401);
  }
  return null;
}

async function readJson(request) {
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    return { error: erasureError('INVALID_BODY', 'invalid json body', 400) };
  }
  if (byteLength(raw) > MAX_BODY_BYTES) {
    return { error: erasureError('INVALID_BODY', 'request body too large', 413) };
  }
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: erasureError('INVALID_BODY', 'invalid json body', 400) };
  }
}

async function runDelete(db, request, deleteRows) {
  const erased = await deleteRows(db, {
    project: request.project,
    subjectType: request.subjectType,
    subject: request.subject,
  });
  const counts = emptyCounts();
  counts.events = Number(erased?.events || 0);
  counts.sessions = Number(erased?.sessions || 0);
  counts.identity_rows = Number(erased?.identity_rows || 0);
  counts.profiles = Number(erased?.profiles || 0);
  counts.email_lookups = Number(erased?.email_lookups || 0);
  return normalizeCounts(counts);
}

async function markCompleted(db, row, counts) {
  const completedAt = Date.now();
  await finishErasure(db, {
    id: row.id,
    project: row.project_name,
    status: 'completed',
    counts,
    error: null,
    completedAt,
  });
  return findErasureById(db, row.id);
}

async function markFailed(db, row, counts) {
  await finishErasure(db, {
    id: row.id,
    project: row.project_name,
    status: 'failed',
    counts,
    error: 'erasure failed',
    completedAt: null,
  });
  return findErasureById(db, row.id);
}

async function resumeErasure(db, row, request, deleteRows) {
  let previous = {};
  try {
    previous = row.counts_json ? JSON.parse(row.counts_json) : {};
  } catch {
    previous = {};
  }
  try {
    const deleted = await runDelete(db, request, deleteRows);
    const counts = addCounts(previous, deleted);
    const saved = await markCompleted(db, row, counts);
    return json(toReceipt(saved), 200);
  } catch {
    console.error('Erasure failed');
    const saved = await markFailed(db, row, normalizeCounts(previous));
    return json(toReceipt(saved), 200);
  }
}

async function postErasure(request, { db, validateRead, deleteRows }) {
  const denied = await requireRead(request, validateRead);
  if (denied) return denied;

  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;

  const validated = validateErasureBody(parsed.body);
  if (!validated.ok) return erasureError(validated.error, validated.message, validated.status);

  const requestBody = validated.value;
  const fingerprint = await erasureFingerprint(requestBody);
  await pruneExpiredReceipts(db);

  let existing = await findErasureByKey(db, requestBody.idempotencyKey);
  if (existing && existing.body_hash !== fingerprint.bodyHash) {
    return erasureError(
      'IDEMPOTENCY_CONFLICT',
      'idempotency_key was already used with a different request body',
      409,
    );
  }
  if (existing && existing.status === 'completed') return json(toReceipt(existing), 200);
  if (existing && (existing.status === 'failed' || existing.status === 'running' || existing.status === 'pending')) {
    return resumeErasure(db, existing, requestBody, deleteRows);
  }

  if (!(await projectHasRows(db, requestBody.project))) {
    return erasureError('PROJECT_NOT_FOUND', 'project not found', 404);
  }

  const matched = await countSubjectEvents(
    db,
    requestBody.project,
    requestBody.subjectType,
    requestBody.subject,
  );
  if (matched > ERASURE_LARGE_EVENT_THRESHOLD && !requestBody.confirmLarge) {
    return erasureError(
      'CONFIRM_LARGE_REQUIRED',
      'subject matches more than 100000 events; set confirm_large to true',
      400,
    );
  }

  const now = Date.now();
  const row = {
    id: newErasureId(),
    project: requestBody.project,
    idempotencyKey: requestBody.idempotencyKey,
    subjectType: requestBody.subjectType,
    subjectHash: fingerprint.subjectHash,
    bodyHash: fingerprint.bodyHash,
    includeReplays: requestBody.includeReplays,
    createdAt: now,
  };

  try {
    await insertRunningErasure(db, row);
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    existing = await findErasureByKey(db, requestBody.idempotencyKey);
    if (!existing) throw error;
    if (existing.body_hash !== fingerprint.bodyHash) {
      return erasureError(
        'IDEMPOTENCY_CONFLICT',
        'idempotency_key was already used with a different request body',
        409,
      );
    }
    if (existing.status === 'completed') return json(toReceipt(existing), 200);
    return resumeErasure(db, existing, requestBody, deleteRows);
  }

  const stored = await findErasureById(db, row.id);
  return resumeErasure(db, stored, requestBody, deleteRows);
}

async function getErasure(request, { db, validateRead }) {
  const denied = await requireRead(request, validateRead);
  if (denied) return denied;

  const url = new URL(request.url);
  let id = url.pathname.slice('/erasures/'.length);
  try {
    id = decodeURIComponent(id);
  } catch {
    return json(errorResponse(ERROR_CODES.NOT_FOUND, 'not found'), 404);
  }
  if (!ERASURE_ID.test(id)) return json(errorResponse(ERROR_CODES.NOT_FOUND, 'not found'), 404);

  const row = await findErasureById(db, id);
  if (!row) return json(errorResponse(ERROR_CODES.NOT_FOUND, 'not found'), 404);
  return json(toReceipt(row), 200);
}

async function listErasures(request, { db, validateRead }) {
  const denied = await requireRead(request, validateRead);
  if (denied) return denied;

  const url = new URL(request.url);
  const project = url.searchParams.get('project');
  if (!project) {
    return json(errorResponse(ERROR_CODES.PROJECT_REQUIRED, 'project query parameter required'), 400);
  }

  const rows = await listErasuresForProject(db, project);
  if (rows.length === 0 && !(await projectHasRows(db, project))) {
    return erasureError('PROJECT_NOT_FOUND', 'project not found', 404);
  }
  return json({
    project,
    erasures: rows.map(toReceipt),
  }, 200);
}

export async function handleErasureRequest(request, options) {
  const url = new URL(request.url);
  const deleteRows = options.deleteRows || deleteSubjectRows;
  const context = { ...options, deleteRows };

  try {
    if (request.method === 'POST' && url.pathname === '/erasures') {
      return postErasure(request, context);
    }
    if (request.method === 'GET' && url.pathname === '/erasures') {
      return listErasures(request, context);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/erasures/')) {
      return getErasure(request, context);
    }
    return json(errorResponse(ERROR_CODES.NOT_FOUND, 'not found'), 404);
  } catch {
    console.error('Erasure failed');
    return json(errorResponse(ERROR_CODES.INTERNAL_ERROR, 'internal error'), 500);
  }
}
