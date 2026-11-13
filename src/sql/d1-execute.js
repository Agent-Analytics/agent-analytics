/**
 * Run a prepared read-only statement on a D1-shaped binding.
 *
 * The Workers binding has no read-only mode. The parser is the only write
 * barrier on this path. Node uses SqliteAdapter.executeReadOnly instead.
 * This function does not cancel the D1 statement. After the route returns
 * SQL_TIMEOUT at 10 seconds, the query can still finish inside D1.
 */

function columnNames(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0] || typeof rows[0] !== 'object') return [];
  return Object.keys(rows[0]);
}

export async function executeD1Sql(db, prepared) {
  const started = performance.now();
  const statement = db.prepare(prepared.sql);
  const bound = prepared.params?.length ? statement.bind(...prepared.params) : statement;
  const result = await bound.all();
  const objects = Array.isArray(result?.results) ? result.results : [];
  const columns = columnNames(objects);
  const rows = objects.map((row) => columns.map((column) => row?.[column] ?? null));
  const duration = Number(result?.meta?.duration);

  return {
    columns,
    rows,
    elapsed_ms: Number.isFinite(duration) ? duration : performance.now() - started,
    rows_read: Number.isFinite(result?.meta?.rows_read) ? result.meta.rows_read : null,
  };
}
