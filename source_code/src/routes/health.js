'use strict';

const express = require('express');
const router = express.Router();

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
