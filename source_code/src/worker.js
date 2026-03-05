'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('bullmq');
const { stringify } = require('csv-stringify');
const { streamRowsKeyset, countRows, buildSelectClause, ALL_COLUMNS } = require('./db');
const { connection } = require('./queue');

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

// ── Background Worker Instance ────────────────────────────────────────────────
const worker = new Worker('export-jobs', async (job) => {
  const exportId = job.data.exportId;
  console.log(`[worker] Processing job ${exportId}`);

  // Ensure export directory exists
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const filePath = path.join(EXPORT_DIR, `export_${exportId}.csv`);
  
  // Inform queue about the filePath so it's queryable via status
  await job.updateData({ ...job.data, filePath });

  const { where, params } = buildWhereClause(job.data.filters);
  const cols = job.data.columns.length > 0 ? job.data.columns : ALL_COLUMNS;

  let processed = 0;
  let total = 0;

  try {
    // ── 1. Count total rows for progress tracking ─────────────────────────────
    total = await countRows(where, params);
    await job.updateProgress({ totalRows: total, processedRows: 0, percentage: 0 });

    // ── 2. Build base SELECT query (without ORDER BY) ─────────────────────────
    const selectClause = buildSelectClause(cols);
    const sql = `SELECT ${selectClause} FROM public.users${where ? ' WHERE ' + where : ''}`;

    // ── 3. Set up csv-stringify in streaming mode ─────────────────────────────
    const csvStringifier = stringify({
      header: true,
      columns: cols,           
      delimiter: job.data.delimiter,
      quote: job.data.quoteChar,
      cast: {
        date: (v) => (v instanceof Date ? v.toISOString() : String(v)),
        number: (v) => String(v),
      },
    });

    const fileStream = fs.createWriteStream(filePath);
    csvStringifier.pipe(fileStream);

    const fileFinished = new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    // ── 4. Stream rows using Keyset Pagination ────────────────────────────────
    for await (const batch of streamRowsKeyset(sql, params)) {
      
      // Cooperative cancellation check - query Redis to see if data.cancelled flag was set
      const currentJobInfo = await job.queue.getJob(job.id);
      if (currentJobInfo && currentJobInfo.data && currentJobInfo.data.cancelled) {
        csvStringifier.destroy();
        fileStream.destroy();
        fs.unlink(filePath, () => {});
        console.log(`[worker] Job ${exportId} cancelled.`);
        throw new Error('aborted-by-user'); // Will mark job as failed in BullMQ, but our API will read `cancelled` flag
      }

      for (const row of batch) {
        const out = {};
        for (const col of cols) {
          out[col] = row[col];
        }

        const ok = csvStringifier.write(out);
        if (!ok) await new Promise((resolve) => csvStringifier.once('drain', resolve));

        processed++;
      }

      // Update progress in BullMQ
      const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
      await job.updateProgress({
        totalRows: total,
        processedRows: processed,
        percentage
      });
    }

    csvStringifier.end();
    await fileFinished;

    console.log(`[worker] Job ${exportId} completed: ${processed} rows → ${filePath}`);
    
    // Return value is stored in BullMQ and accessible via job.returnvalue
    return { filePath, processedRows: processed };

  } catch (err) {
    console.error(`[worker] Job ${exportId} failed:`, err.message);
    
    // Clean up partial file on failure
    if (fs.existsSync(filePath)) {
       fs.unlink(filePath, () => {});
    }

    throw err; // Let BullMQ handle the failure state
  }
}, { connection, concurrency: 3 }); // Allow max 3 parallel exports per Node instance

worker.on('error', err => {
  console.error('[worker] BullMQ Worker error:', err.message);
});

module.exports = { worker }; // exported just to keep it alive
