'use strict';

const { Pool } = require('pg');
const Cursor = require('pg-cursor');

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
 * Opens a pg-cursor and yields row batches.
 * Memory usage is O(batchSize), not O(totalRows).
 *
 * @param {string} sql
 * @param {Array}  params
 * @param {number} [batchSize]
 * @returns {AsyncGenerator<object[]>}
 */
async function* streamRows(sql, params = [], batchSize) {
  const size = batchSize || parseInt(process.env.DB_CURSOR_BATCH_SIZE, 10) || 1000;
  const client = await pool.connect();

  try {
    const cursor = client.query(new Cursor(sql, params));
    while (true) {
      const rows = await cursor.read(size);
      if (rows.length === 0) break;
      yield rows;
    }
    await cursor.close();
  } finally {
    client.release();
  }
}

module.exports = { pool, streamRows, countRows, buildSelectClause, ALLOWED_COLUMNS, ALL_COLUMNS };
