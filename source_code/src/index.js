'use strict';

const fs = require('fs');
const express = require('express');
const exportsRouter = require('./routes/exports');
const healthRouter  = require('./routes/health');
require('./worker'); // Start the BullMQ background worker

const app = express();
const PORT = process.env.PORT || 8080;
const EXPORT_DIR = process.env.EXPORT_STORAGE_PATH || '/app/exports';

// ── Ensure export storage directory exists ────────────────────────────────────
fs.mkdirSync(EXPORT_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',  healthRouter);
app.use('/exports', exportsRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Async Streaming Export Service listening on port ${PORT}`);
  console.log(`[server] Export storage: ${EXPORT_DIR}`);
});

module.exports = app; // exported for tests
