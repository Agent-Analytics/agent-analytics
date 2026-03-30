import { validatePropertyKey } from '@agent-analytics/core/base-adapter';
import { today, parseSince } from '../../node_modules/@agent-analytics/core/src/db/adapter.js';
import { AnalyticsError, ERROR_CODES } from '../../node_modules/@agent-analytics/core/src/errors.js';
import {
  METRICS,
  ALLOWED_METRICS,
  GROUP_BY_FIELDS,
  ALLOWED_GROUP_BY,
  FILTER_OPS,
  FILTERABLE_FIELDS,
  ALLOWED_ORDER_BY,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../../node_modules/@agent-analytics/core/src/constants.js';

export async function queryWithSessionMetrics(adapter, {
  project,
  metrics = [METRICS.EVENT_COUNT],
  filters,
  date_from,
  date_to,
  group_by = [],
  order_by,
  order,
  limit = DEFAULT_LIMIT,
}) {
  for (const metric of metrics) {
    if (!ALLOWED_METRICS.includes(metric)) {
      throw new AnalyticsError(
        ERROR_CODES.INVALID_METRIC,
        `invalid metric: ${metric}. allowed: ${ALLOWED_METRICS.join(', ')}`,
        400,
      );
    }
  }

  for (const groupField of group_by) {
    if (!ALLOWED_GROUP_BY.includes(groupField)) {
      throw new AnalyticsError(
        ERROR_CODES.INVALID_GROUP_BY,
        `invalid group_by: ${groupField}. allowed: ${ALLOWED_GROUP_BY.join(', ')}`,
        400,
      );
    }
  }

  const selectParts = [...group_by];
  for (const metric of metrics) {
    if (metric === METRICS.EVENT_COUNT) selectParts.push('COUNT(*) as event_count');
    if (metric === METRICS.UNIQUE_USERS) selectParts.push('COUNT(DISTINCT user_id) as unique_users');
    if (metric === METRICS.SESSION_COUNT) selectParts.push('COUNT(DISTINCT session_id) as session_count');
    if (metric === METRICS.BOUNCE_RATE) selectParts.push('COUNT(DISTINCT session_id) as _session_count_for_bounce');
    if (metric === METRICS.AVG_DURATION) selectParts.push('COUNT(DISTINCT session_id) as _session_count_for_duration');
  }
  if (selectParts.length === 0) selectParts.push('COUNT(*) as event_count');

  const fromDate = parseSince(date_from);
  const toDate = date_to || today();
  const whereParts = ['project_id = ?', 'date >= ?', 'date <= ?'];
  const params = [project, fromDate, toDate];

  if (filters && Array.isArray(filters)) {
    for (const filter of filters) {
      if (!filter.field || !filter.op || filter.value === undefined) continue;

      const sqlOp = FILTER_OPS[filter.op];
      if (!sqlOp) {
        throw new AnalyticsError(
          ERROR_CODES.INVALID_FILTER_OP,
          `invalid filter op: ${filter.op}. allowed: ${Object.keys(FILTER_OPS).join(', ')}`,
          400,
        );
      }

      if (FILTERABLE_FIELDS.includes(filter.field)) {
        if (filter.op === 'contains') {
          whereParts.push(`${filter.field} LIKE '%' || ? || '%'`);
        } else {
          whereParts.push(`${filter.field} ${sqlOp} ?`);
        }
        params.push(filter.value);
        continue;
      }

      if (filter.field.startsWith('properties.')) {
        const propKey = filter.field.replace('properties.', '');
        validatePropertyKey(propKey);
        if (filter.op === 'contains') {
          whereParts.push(`json_extract(properties, '$.${propKey}') LIKE '%' || ? || '%'`);
        } else {
          whereParts.push(`json_extract(properties, '$.${propKey}') ${sqlOp} ?`);
        }
        params.push(filter.value);
      }
    }
  }

  const usesSessionMetrics = metrics.includes(METRICS.BOUNCE_RATE) || metrics.includes(METRICS.AVG_DURATION);
  const usesEventMetrics = metrics.includes(METRICS.EVENT_COUNT)
    || metrics.includes(METRICS.UNIQUE_USERS)
    || metrics.includes(METRICS.SESSION_COUNT);

  let sql;
  if (!usesSessionMetrics) {
    sql = `SELECT ${selectParts.join(', ')} FROM events WHERE ${whereParts.join(' AND ')}`;
    if (group_by.length > 0) sql += ` GROUP BY ${group_by.join(', ')}`;
  } else {
    const ctes = [
      `filtered_events AS (
        SELECT event, date, user_id, session_id, country
        FROM events
        WHERE ${whereParts.join(' AND ')}
      )`,
    ];
    const cteParams = [...params];

    if (usesEventMetrics || group_by.length > 0) {
      ctes.push(`event_agg AS (
        SELECT ${selectParts.join(', ')}
        FROM filtered_events
        ${group_by.length > 0 ? `GROUP BY ${group_by.join(', ')}` : ''}
      )`);
    }

    cteParams.push(project);
    const sessionMetricBaseSelect = [];
    if (group_by.length > 0) {
      sessionMetricBaseSelect.push(...group_by.map(field => `fe.${field} as ${field}`));
    }
    sessionMetricBaseSelect.push(
      'fe.session_id as session_id',
      'MAX(COALESCE(s.is_bounce, 0)) as _is_bounce',
      'MAX(COALESCE(s.duration, 0)) as _duration',
    );
    ctes.push(`session_metrics AS (
      SELECT ${sessionMetricBaseSelect.join(', ')}
      FROM filtered_events fe
      LEFT JOIN sessions s
        ON s.project_id = ? AND s.session_id = fe.session_id
      WHERE fe.session_id IS NOT NULL
      GROUP BY ${group_by.length > 0 ? `${group_by.map(field => `fe.${field}`).join(', ')}, ` : ''}fe.session_id
    )`);

    const sessionMetricSelects = [];
    if (group_by.length > 0) {
      sessionMetricSelects.push(...group_by);
    }
    if (metrics.includes(METRICS.BOUNCE_RATE)) {
      sessionMetricSelects.push('ROUND(AVG(CASE WHEN _is_bounce = 1 THEN 1.0 ELSE 0 END), 3) as bounce_rate');
    }
    if (metrics.includes(METRICS.AVG_DURATION)) {
      sessionMetricSelects.push('ROUND(AVG(_duration)) as avg_duration');
    }
    ctes.push(`session_agg AS (
      SELECT ${sessionMetricSelects.join(', ')}
      FROM session_metrics
      ${group_by.length > 0 ? `GROUP BY ${group_by.join(', ')}` : ''}
    )`);

    const finalSelectParts = [];
    const finalParams = [...cteParams];

    if (usesEventMetrics || group_by.length > 0) {
      finalSelectParts.push(...group_by.map(field => `ea.${field} as ${field}`));
      if (metrics.includes(METRICS.EVENT_COUNT)) finalSelectParts.push('ea.event_count');
      if (metrics.includes(METRICS.UNIQUE_USERS)) finalSelectParts.push('ea.unique_users');
      if (metrics.includes(METRICS.SESSION_COUNT)) finalSelectParts.push('ea.session_count');
      if (metrics.includes(METRICS.BOUNCE_RATE)) finalSelectParts.push('COALESCE(sa.bounce_rate, 0) as bounce_rate');
      if (metrics.includes(METRICS.AVG_DURATION)) finalSelectParts.push('COALESCE(sa.avg_duration, 0) as avg_duration');

      sql = `WITH ${ctes.join(', ')}
        SELECT ${finalSelectParts.join(', ')}
        FROM event_agg ea`;
      if (group_by.length > 0) {
        sql += ` LEFT JOIN session_agg sa ON ${group_by.map(field => `ea.${field} IS sa.${field}`).join(' AND ')}`;
      } else {
        sql += ' CROSS JOIN session_agg sa';
      }
    } else {
      if (metrics.includes(METRICS.BOUNCE_RATE)) {
        finalSelectParts.push('COALESCE(bounce_rate, 0) as bounce_rate');
      }
      if (metrics.includes(METRICS.AVG_DURATION)) {
        finalSelectParts.push('COALESCE(avg_duration, 0) as avg_duration');
      }
      sql = `WITH ${ctes.join(', ')}
        SELECT ${finalSelectParts.join(', ')}
        FROM session_agg`;
    }

    params.length = 0;
    params.push(...finalParams);
  }

  const defaultOrder = group_by.includes(GROUP_BY_FIELDS.DATE)
    ? GROUP_BY_FIELDS.DATE
    : (metrics[0] || group_by[0] || METRICS.EVENT_COUNT);
  const orderField = order_by && ALLOWED_ORDER_BY.includes(order_by) ? order_by : defaultOrder;
  const orderDir = order === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${orderField} ${orderDir}`;

  const maxLimit = Math.min(limit, MAX_LIMIT);
  sql += ' LIMIT ?';
  params.push(maxLimit);

  const rows = await adapter._queryAll(sql, params);
  return {
    period: { from: fromDate, to: toDate },
    metrics,
    group_by,
    rows,
    count: rows.length,
  };
}
