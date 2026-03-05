'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { addExportJob, getJobStatus, cancelExportJob } = require('../queue');
const { buildSelectClause, ALLOWED_COLUMNS, ALL_COLUMNS } = require('../db');

const VALID_TIERS = new Set(['free', 'basic', 'premium', 'enterprise']);
const EXPORT_DIR = process.env.EXPORT_STORAGE_PATH || '/app/exports';

// ── POST /exports/csv ─────────────────────────────────────────────────────────
// Initiates a background CSV export job and returns 202 immediately.
router.post('/csv', async (req, res) => {
  // ── Parse and validate query params ──────────────────────────────────────
  const {
    country_code,
    subscription_tier,
    min_ltv,
    columns: colsParam,
    delimiter = ',',
    quoteChar = '"',
  } = req.query;

  // Validate delimiter (must be a single character)
  if (delimiter.length !== 1) {
    return res.status(400).json({ error: '"delimiter" must be a single character.' });
  }
  if (quoteChar.length !== 1) {
    return res.status(400).json({ error: '"quoteChar" must be a single character.' });
  }

  // Parse columns
  let cols = [];
  if (colsParam) {
    cols = colsParam.split(',').map((c) => c.trim()).filter(Boolean);
    try {
      buildSelectClause(cols); // validates against allowlist
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Validate min_ltv
  let minLtv = null;
  if (min_ltv !== undefined) {
    minLtv = parseFloat(min_ltv);
    if (isNaN(minLtv)) {
      return res.status(400).json({ error: '"min_ltv" must be a number.' });
    }
  }

  // Validate country_code (2 uppercase letters)
  if (country_code && !/^[A-Z]{2}$/i.test(country_code)) {
    return res.status(400).json({ error: '"country_code" must be a 2-letter country code.' });
  }

  // Validate subscription_tier
  if (subscription_tier && !VALID_TIERS.has(subscription_tier)) {
    return res.status(400).json({
      error: `"subscription_tier" must be one of: ${[...VALID_TIERS].join(', ')}.`,
    });
  }

  // ── Create job and add to Redis queue ─────────────────────────────────────
  const jobData = {
    columns: cols,
    delimiter,
    quoteChar,
    filters: {
      countryCode: country_code ? country_code.toUpperCase() : null,
      subscriptionTier: subscription_tier || null,
      minLtv,
    },
  };

  try {
    const exportId = await addExportJob(jobData);
    return res.status(202).json({
      exportId,
      status: 'pending',
    });
  } catch (err) {
    console.error('Failed to enqueue job:', err);
    return res.status(500).json({ error: 'Failed to enqueue export job' });
  }
});

// ── GET /exports/:id/status ───────────────────────────────────────────────────
router.get('/:id/status', async (req, res) => {
  try {
    const statusObj = await getJobStatus(req.params.id);
    if (!statusObj) {
      return res.status(404).json({ error: 'Export job not found.' });
    }
    return res.status(200).json(statusObj);
  } catch (err) {
    console.error('Failed to get job status:', err);
    return res.status(500).json({ error: 'Failed to retrieve job status' });
  }
});

// ── GET /exports/:id/download ─────────────────────────────────────────────────
router.get('/:id/download', async (req, res) => {
  try {
    const job = await getJobStatus(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Export job not found.' });
    }

    if (job.status === 'processing' || job.status === 'pending') {
      return res.status(425).json({
        error: 'Export is still in progress. Poll /status until status is "completed".',
        status: job.status,
        progress: job.progress,
      });
    }

    if (job.status !== 'completed' || !job.filePath) {
      return res.status(404).json({
        error: `Export is not available (status: ${job.status}).`,
      });
    }

    // Verify file still exists
    if (!fs.existsSync(job.filePath)) {
      return res.status(404).json({ error: 'Export file not found on disk.' });
    }

    const filename = `export_${job.exportId}.csv`;
    const fileStat = fs.statSync(job.filePath);
    const fileSize = fileStat.size;

    // Detect gzip preference
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const wantsGzip = acceptEncoding.includes('gzip');

    // ── Range request (resumable downloads) ──────────────────────────────────
    const rangeHeader = req.headers['range'];

    if (rangeHeader && !wantsGzip) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        return res.status(416).send('Range Not Satisfiable');
      }

      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end   = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start > end || start >= fileSize) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).send('Range Not Satisfiable');
      }

      const chunkSize = end - start + 1;

      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.status(206);

      const readStream = fs.createReadStream(job.filePath, { start, end });
      readStream.pipe(res);
      return;
    }

    // ── Full download ─────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    if (wantsGzip) {
      // On-the-fly gzip: content-length is unknown → use chunked transfer
      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');

      const readStream = fs.createReadStream(job.filePath);
      const gzip = zlib.createGzip();
      readStream.pipe(gzip).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      const readStream = fs.createReadStream(job.filePath);
      readStream.pipe(res);
    }
  } catch (err) {
    console.error('Failed to handle download request:', err);
    return res.status(500).json({ error: 'Internal server error while processing download' });
  }
});

// ── DELETE /exports/:id ───────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const job = await getJobStatus(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Export job not found.' });
    }

    // Signal cooperative cancellation via Redis
    await cancelExportJob(req.params.id);

    // If already completed, clean up the file
    if (job.status === 'completed' && job.filePath) {
      fs.unlink(job.filePath, () => {});
    }

    return res.status(204).end();
  } catch (err) {
    console.error('Failed to cancel job:', err);
    return res.status(500).json({ error: 'Failed to cancel export job' });
  }
});

module.exports = router;
