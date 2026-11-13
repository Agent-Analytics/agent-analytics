/**
 * POST /erasures body rules shared with the hosted contract.
 * OSS rejects portfolio: true because this server has no portfolio scope.
 */

const SUBJECT_FIELDS = ['user_id', 'session_id', 'email'];
const MAX_SUBJECT_LENGTH = 256;
const MAX_KEY_LENGTH = 256;
const MAX_PROJECT_LENGTH = 1024;

function invalid(message) {
  return { ok: false, status: 400, error: 'INVALID_ERASURE', message };
}

export function validateErasureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'INVALID_BODY', message: 'invalid json body' };
  }

  if (typeof body.project !== 'string' || body.project.length === 0 || body.project.length > MAX_PROJECT_LENGTH) {
    return invalid('project is required');
  }

  if (typeof body.idempotency_key !== 'string' || body.idempotency_key.length === 0 || body.idempotency_key.length > MAX_KEY_LENGTH) {
    return invalid('idempotency_key is required');
  }

  if (body.confirm !== 'erase') {
    return invalid('confirm must be erase');
  }

  const present = SUBJECT_FIELDS.filter((field) => body[field] !== undefined && body[field] !== null);
  if (present.length !== 1) {
    return invalid('send exactly one of user_id, session_id, or email');
  }

  const subjectType = present[0];
  const subject = body[subjectType];
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
    return invalid(`${subjectType} must be a non-empty string of at most 256 characters`);
  }

  if (body.include_replays !== undefined && typeof body.include_replays !== 'boolean') {
    return invalid('include_replays must be a boolean');
  }

  if (body.portfolio !== undefined && typeof body.portfolio !== 'boolean') {
    return invalid('portfolio must be a boolean');
  }

  if (body.confirm_large !== undefined && typeof body.confirm_large !== 'boolean') {
    return invalid('confirm_large must be a boolean');
  }

  if (subjectType === 'email') {
    return invalid('email erasure is not supported on self-hosted because there is no email lookup');
  }

  if (body.portfolio === true) {
    return invalid('portfolio erasure is not available on this server');
  }

  return {
    ok: true,
    value: {
      project: body.project,
      idempotencyKey: body.idempotency_key,
      subjectType,
      subject,
      includeReplays: body.include_replays !== false,
      portfolio: false,
      confirmLarge: body.confirm_large === true,
    },
  };
}
