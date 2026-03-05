'use strict';

const { Pool } = require('pg');

// ── Connection Pool ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected client error:', err.message);
});

// ── Allowed columns (SQL injection guard) ─────────────────────────────────────
const ALLOWED_COLUMNS = new Set([
  'id',
  'name',
  'email',
  'signup_date',
  'country_code',
  'subscription_tier',
  'lifetime_value',
]);

const ALL_COLUMNS = [...ALLOWED_COLUMNS];

/**
 * Validates and builds a quoted SELECT clause from requested column names.
 * @param {string[]} cols  Array of column name strings
 * @returns {string}  e.g. '"id", "name", "email"'
 */
function buildSelectClause(cols) {
  const invalid = cols.filter((c) => !ALLOWED_COLUMNS.has(c));
  if (invalid.length) {
    throw new Error(`Invalid column(s): ${invalid.join(', ')}`);
  }
  return cols.map((c) => `"${c}"`).join(', ');
}

/**
 * Counts rows matching a WHERE clause.
 * @param {string} where   SQL WHERE clause fragment (may be empty string)
 * @param {Array}  params  Bound parameters
 * @returns {Promise<number>}
 */
async function countRows(where, params = []) {
  const sql = `SELECT COUNT(*) AS cnt FROM public.users${where ? ' WHERE ' + where : ''}`;
  const { rows } = await pool.query(sql, params);
  return parseInt(rows[0].cnt, 10);
}

/**
 * Implements stateless Keyset Pagination (`WHERE id > last_id ORDER BY id`).
 * Releases the DB connection back to the pool *between* batches.
 *
 * @param {string} baseSql - Ensure it DOES NOT contain an ORDER BY clause.
 * @param {Array}  params  - Bound parameters matching the WHERE clause inside baseSql.
 * @param {number} [batchSize]
 * @returns {AsyncGenerator<object[]>}
 */
async function* streamRowsKeyset(baseSql, params = [], batchSize) {
  const size = batchSize || parseInt(process.env.DB_CURSOR_BATCH_SIZE, 10) || 1000;
  let lastId = 0; // Assuming `id` is a strictly positive SERIAL primary key

  // We append the keyset condition.
  // E.g: "SELECT ... FROM ... WHERE ... AND id > $lastId ORDER BY id LIMIT $limit"
  // If baseSql has no WHERE, we add one.
  const hasWhere = baseSql.toUpperCase().includes(' WHERE ');
  const linkWord = hasWhere ? ' AND' : ' WHERE';

  let done = false;

  while (!done) {
    // 1. We allocate the DB connection dynamically per-batch
    const client = await pool.connect();

    try {
      // 2. Build the exact query
      // The params array has length N. 
      // lastId will be param N+1
      const queryParams = [...params, lastId];
      const idParamIdx = queryParams.length; // 1-indexed for postgres, e.g. $1

      const keysetSql = `${baseSql}${linkWord} id > $${idParamIdx} ORDER BY id ASC LIMIT ${size}`;
      
      // 3. Execute
      const { rows } = await client.query(keysetSql, queryParams);
      
      if (rows.length === 0) {
        done = true;
      } else {
        lastId = rows[rows.length - 1].id;
        yield rows;
      }

    } finally {
      // 4. Critically: Release the connection back to the pool instantly
      client.release();
    }
  }
}

module.exports = { pool, streamRowsKeyset, countRows, buildSelectClause, ALLOWED_COLUMNS, ALL_COLUMNS };
