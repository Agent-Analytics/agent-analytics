/**
 * Hashes for erasure receipts. The raw subject is never stored or logged.
 * Subject hashing uses the shared helper so a receipt matches core.
 */

import { hashErasureSubject } from '@agent-analytics/core/erasure';

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export async function erasureFingerprint({
  project,
  subjectType,
  subject,
  includeReplays,
  portfolio,
  confirmLarge,
}) {
  const subjectHash = await hashErasureSubject(subject);
  const canonical = JSON.stringify({
    confirm_large: confirmLarge === true,
    include_replays: includeReplays !== false,
    portfolio: portfolio === true,
    project,
    subject_hash: subjectHash,
    subject_type: subjectType,
  });
  return {
    subjectHash,
    bodyHash: await sha256Hex(canonical),
  };
}
