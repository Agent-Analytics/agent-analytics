/**
 * POST /query property group-by. The rule lives in @agent-analytics/core.
 * These tests check that the OSS server returns it unchanged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SqliteAdapter } from '../db/sqlite.js';
import { makeValidateWrite, makeValidateRead } from '../auth.js';
import { createOssHandler } from '../oss-handler.js';

const PROJECT = 'group-project';
const TOKEN = 'pt_test';
const API_KEY = 'aak_secret';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let handler;

function postJSON(path, body) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function track(body) {
  const result = await handler(postJSON('/track', { token: TOKEN, project: PROJECT, ...body }));
  if (result.writeOps) await Promise.all(result.writeOps);
  expect(result.response.status).toBe(200);
}

async function query(body) {
  const { response } = await handler(postJSON('/query', { project: PROJECT, ...body }));
  const data = await response.json();
  return { status: response.status, data };
}

beforeAll(async () => {
  const db = new SqliteAdapter(':memory:');
  handler = createOssHandler({
    db,
    validateWrite: makeValidateWrite(TOKEN),
    validateRead: makeValidateRead(API_KEY),
    executeSql: (prepared) => db.executeReadOnly(prepared.sql, prepared.params),
  });

  await track({ event: 'page_view', properties: { path: '/pricing' }, user_id: 'u1' });
  await track({ event: 'page_view', properties: { path: '/pricing' }, user_id: 'u2' });
  await track({ event: 'page_view', properties: { path: '/docs' }, user_id: 'u1' });
  await track({ event: 'signup', properties: { plan: 'pro' }, user_id: 'u3' });
  await track({ event: 'page_view', user_id: 'u4' });
});

describe('POST /query properties group-by', () => {
  it('groups one property together with an existing field', async () => {
    const { status, data } = await query({
      metrics: ['event_count', 'unique_users'],
      group_by: ['event', 'properties.path'],
      filters: [{ field: 'event', op: 'eq', value: 'page_view' }],
      limit: 100,
    });

    expect(status).toBe(200);
    expect(data.group_by).toEqual(['event', 'properties.path']);
    const byPath = Object.fromEntries(data.rows.map((row) => [row['properties.path'], row]));
    expect(byPath['/pricing']).toMatchObject({
      event: 'page_view',
      'properties.path': '/pricing',
      event_count: 2,
      unique_users: 2,
    });
    expect(byPath['/docs']).toMatchObject({
      event: 'page_view',
      'properties.path': '/docs',
      event_count: 1,
      unique_users: 1,
    });
    expect(byPath[null]).toMatchObject({
      event: 'page_view',
      'properties.path': null,
      event_count: 1,
      unique_users: 1,
    });
  });

  it('groups a missing property as null', async () => {
    const { status, data } = await query({
      metrics: ['event_count'],
      group_by: ['properties.path'],
      filters: [{ field: 'event', op: 'eq', value: 'page_view' }],
    });

    expect(status).toBe(200);
    const missing = data.rows.find((row) => row['properties.path'] === null);
    expect(missing).toMatchObject({
      'properties.path': null,
      event_count: 1,
    });
  });

  it('rejects a second properties group', async () => {
    const { status, data } = await query({
      metrics: ['event_count'],
      group_by: ['properties.path', 'properties.plan'],
    });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_GROUP_BY');
  });

  it('rejects a property key the filter validator would reject', async () => {
    const { status, data } = await query({
      metrics: ['event_count'],
      group_by: ['properties.bad-key'],
    });
    expect(status).toBe(400);
    expect(data.error).toBe('INVALID_PROPERTY_KEY');
  });

  it('still groups by an existing field', async () => {
    const { status, data } = await query({
      metrics: ['event_count'],
      group_by: ['event'],
    });
    expect(status).toBe(200);
    const signup = data.rows.find((row) => row.event === 'signup');
    expect(signup.event_count).toBe(1);
  });

  it('applies the date range and the 1000 row cap', async () => {
    const outside = await query({
      metrics: ['event_count'],
      group_by: ['properties.path'],
      date_from: '2099-01-01',
      date_to: '2099-01-02',
    });
    expect(outside.status).toBe(200);
    expect(outside.data.rows).toEqual([]);

    const capped = await query({
      metrics: ['event_count'],
      group_by: ['properties.path'],
      limit: 1,
    });
    expect(capped.status).toBe(200);
    expect(capped.data.count).toBe(1);
    expect(capped.data.rows).toHaveLength(1);
  });
});
