'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify');
const { streamRows, countRows, buildSelectClause, ALL_COLUMNS } = require('./db');
const { getJob } = require('./jobs');

const EXPORT_DIR = process.env.EXPORT_STORAGE_PATH || '/app/exports';

/**
 * Builds a SQL WHERE clause and params array from job filters.
 * @param {object} filters
 * @returns {{ where: string, params: Array }}
 */
function buildWhereClause(filters) {
  const clauses = [];
  const params = [];
  let idx = 1;

  if (filters.countryCode) {
    clauses.push(`country_code = $${idx++}`);
    params.push(filters.countryCode);
  }
  if (filters.subscriptionTier) {
    clauses.push(`subscription_tier = $${idx++}`);
    params.push(filters.subscriptionTier);
  }
  if (filters.minLtv !== null && filters.minLtv !== undefined) {
    clauses.push(`lifetime_value >= $${idx++}`);
    params.push(filters.minLtv);
  }

  return {
    where: clauses.length ? clauses.join(' AND ') : '',
    params,
  };
}

/**
 * Runs a streaming CSV export job in the background.
 * Updates job.progress as rows are processed.
 * Respects job.cancelToken.cancelled for cooperative cancellation.
 *
 * @param {string} exportId
 */
async function runExportJob(exportId) {
  const job = getJob(exportId);
  if (!job) return;

  // Ensure export directory exists
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const filePath = path.join(EXPORT_DIR, `export_${exportId}.csv`);
  job.filePath = filePath;
  job.status = 'processing';

  const { where, params } = buildWhereClause(job.filters);
  const cols = job.columns.length > 0 ? job.columns : ALL_COLUMNS;

  try {
    // ── 1. Count total rows for progress tracking ─────────────────────────────
    const total = await countRows(where, params);
    job.progress.totalRows = total;

    // ── 2. Build SELECT query ─────────────────────────────────────────────────
    const selectClause = buildSelectClause(cols);
    const sql = `SELECT ${selectClause} FROM public.users${where ? ' WHERE ' + where : ''} ORDER BY id`;

    // ── 3. Set up csv-stringify in streaming mode ─────────────────────────────
    const csvStringifier = stringify({
      header: true,
      columns: cols,           // array of column names → used as header + key lookup
      delimiter: job.delimiter,
      quote: job.quoteChar,
      cast: {
        date: (v) => (v instanceof Date ? v.toISOString() : String(v)),
        number: (v) => String(v),
      },
    });

    const fileStream = fs.createWriteStream(filePath);

    // Pipe CSV stringifier → file
    csvStringifier.pipe(fileStream);

    // Wait for the file to finish writing
    const fileFinished = new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    // ── 4. Stream rows from DB and write to CSV ───────────────────────────────
    let processed = 0;

    for await (const batch of streamRows(sql, params)) {
      // Cooperative cancellation check
      if (job.cancelToken.cancelled) {
        csvStringifier.destroy();
        fileStream.destroy();
        // Clean up partial file
        fs.unlink(filePath, () => {});
        job.status = 'cancelled';
        job.filePath = null;
        console.log(`[worker] Job ${exportId} cancelled.`);
        return;
      }

      for (const row of batch) {
        // Build row object keyed by column names
        const out = {};
        for (const col of cols) {
          out[col] = row[col];
        }

        // Respect back-pressure: await drain if buffer is full
        const ok = csvStringifier.write(out);
        if (!ok) await new Promise((resolve) => csvStringifier.once('drain', resolve));

        processed++;
      }

      // Update progress after each batch
      job.progress.processedRows = processed;
      job.progress.percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
    }

    csvStringifier.end();
    await fileFinished;

    // ── 5. Mark complete ──────────────────────────────────────────────────────
    job.status = 'completed';
    job.progress.processedRows = processed;
    job.progress.percentage = 100;
    job.completedAt = new Date().toISOString();

    console.log(`[worker] Job ${exportId} completed: ${processed} rows → ${filePath}`);
  } catch (err) {
    console.error(`[worker] Job ${exportId} failed:`, err.message);
    job.status = 'failed';
    job.error = err.message;
    job.completedAt = new Date().toISOString();

    // Clean up partial file
    if (filePath) fs.unlink(filePath, () => {});
    job.filePath = null;
  }
}

/**
 * Starts the export job asynchronously (non-blocking).
 * Returns immediately; the job runs in the background.
 * @param {string} exportId
 */
function startWorker(exportId) {
  // setImmediate defers execution to the next event-loop tick
  setImmediate(() => {
    runExportJob(exportId).catch((err) => {
      console.error(`[worker] Unhandled error for job ${exportId}:`, err.message);
    });
  });
}

module.exports = { startWorker };
