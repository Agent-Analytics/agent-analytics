function formatDate(timestamp) {
  return new Date(timestamp).toISOString().split('T')[0];
}

function canonicalUserExpression(userId, project) {
  if (!userId || !project) {
    return { sql: 'NULL', params: [] };
  }

  return {
    sql: `COALESCE(
      (SELECT canonical_id FROM identity_map WHERE previous_id = ? AND project_id = ?),
      ?
    )`,
    params: [userId, project, userId],
  };
}

export function buildEventInsertStatement({ id, project, event, properties, user_id, session_id, timestamp, country }) {
  const ts = timestamp || Date.now();
  const date = formatDate(ts);
  const canonicalUser = canonicalUserExpression(user_id, project);

  return {
    sql: `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date, country)
       VALUES (?, ?, ?, ?, ${canonicalUser.sql}, ?, ?, ?, ?)`,
    params: [
      id,
      project,
      event,
      properties ? JSON.stringify(properties) : null,
      ...canonicalUser.params,
      session_id || null,
      ts,
      date,
      country || null,
    ],
  };
}

export function buildSessionUpsertStatement({ project, session_id, user_id, timestamp, properties, count = 1 }) {
  const ts = timestamp || Date.now();
  const date = formatDate(ts);
  const page = (properties && typeof properties === 'object')
    ? (properties.path || properties.url || null)
    : null;
  const canonicalUser = canonicalUserExpression(user_id, project);

  return {
    sql: `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
       VALUES (?, ${canonicalUser.sql}, ?, ?, ?, 0, ?, ?, ?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = COALESCE(excluded.user_id, sessions.user_id),
         start_time = MIN(sessions.start_time, excluded.start_time),
         end_time = MAX(sessions.end_time, excluded.end_time),
         duration = MAX(sessions.end_time, excluded.end_time) - MIN(sessions.start_time, excluded.start_time),
         entry_page = CASE WHEN excluded.start_time < sessions.start_time THEN excluded.entry_page ELSE sessions.entry_page END,
         exit_page = CASE WHEN excluded.end_time >= sessions.end_time THEN excluded.exit_page ELSE sessions.exit_page END,
         event_count = sessions.event_count + excluded.event_count,
         is_bounce = CASE WHEN sessions.event_count + excluded.event_count > 1 THEN 0 ELSE 1 END`,
    params: [
      session_id,
      ...canonicalUser.params,
      project,
      ts,
      ts,
      page,
      page,
      count,
      date,
    ],
  };
}

export function buildIdentifyStatements({ project, previous_id, canonical_id, created_at = Date.now() }) {
  const canonicalUser = canonicalUserExpression(canonical_id, project);

  return [
    {
      sql: `UPDATE identity_map
         SET canonical_id = ${canonicalUser.sql}
         WHERE canonical_id = ? AND project_id = ?`,
      params: [...canonicalUser.params, previous_id, project],
    },
    {
      sql: `INSERT INTO identity_map (previous_id, canonical_id, project_id, created_at)
         VALUES (?, ${canonicalUser.sql}, ?, ?)
         ON CONFLICT(previous_id, project_id) DO UPDATE SET
           canonical_id = ${canonicalUser.sql},
           created_at = excluded.created_at`,
      params: [
        previous_id,
        ...canonicalUser.params,
        project,
        created_at,
        ...canonicalUser.params,
      ],
    },
    {
      sql: `UPDATE events
         SET user_id = ${canonicalUser.sql}
         WHERE user_id = ? AND project_id = ?`,
      params: [...canonicalUser.params, previous_id, project],
    },
    {
      sql: `UPDATE sessions
         SET user_id = ${canonicalUser.sql}
         WHERE user_id = ? AND project_id = ?`,
      params: [...canonicalUser.params, previous_id, project],
    },
  ];
}
