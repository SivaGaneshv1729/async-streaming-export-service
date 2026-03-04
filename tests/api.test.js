'use strict';

const request = require('supertest');
const app = require('../source_code/src/index');

// ── GET /health ───────────────────────────────────────────────────────────────
describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ── POST /exports/csv ─────────────────────────────────────────────────────────
describe('POST /exports/csv', () => {
  test('returns 202 with exportId UUID and status pending', async () => {
    const res = await request(app).post('/exports/csv');
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('exportId');
    expect(res.body).toHaveProperty('status', 'pending');
    expect(res.body.exportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  test('accepts valid column selection', async () => {
    const res = await request(app).post('/exports/csv?columns=id,email,country_code');
    expect(res.status).toBe(202);
    expect(res.body.exportId).toBeTruthy();
  });

  test('accepts valid filter parameters', async () => {
    const res = await request(app).post('/exports/csv?country_code=US&subscription_tier=premium&min_ltv=500');
    expect(res.status).toBe(202);
  });

  test('accepts custom delimiter', async () => {
    const res = await request(app).post('/exports/csv?delimiter=|');
    expect(res.status).toBe(202);
  });

  test('accepts custom quoteChar', async () => {
    const res = await request(app).post("/exports/csv?quoteChar='");
    expect(res.status).toBe(202);
  });

  test('returns 400 for invalid column name (SQL injection guard)', async () => {
    const res = await request(app).post('/exports/csv?columns=id,injected;DROP TABLE users;--');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('returns 400 for multi-char delimiter', async () => {
    const res = await request(app).post('/exports/csv?delimiter=||');
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid subscription_tier', async () => {
    const res = await request(app).post('/exports/csv?subscription_tier=unknown');
    expect(res.status).toBe(400);
  });

  test('returns 400 for non-numeric min_ltv', async () => {
    const res = await request(app).post('/exports/csv?min_ltv=abc');
    expect(res.status).toBe(400);
  });
});

// ── GET /exports/:id/status ───────────────────────────────────────────────────
describe('GET /exports/:id/status', () => {
  test('returns 404 for unknown exportId', async () => {
    const res = await request(app).get('/exports/00000000-0000-4000-8000-000000000000/status');
    expect(res.status).toBe(404);
  });

  test('returns status object with correct schema for a known job', async () => {
    const createRes = await request(app).post('/exports/csv');
    const { exportId } = createRes.body;

    const res = await request(app).get(`/exports/${exportId}/status`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('exportId', exportId);
    expect(res.body).toHaveProperty('status');
    expect(['pending', 'processing', 'completed', 'failed', 'cancelled']).toContain(res.body.status);
    expect(res.body).toHaveProperty('progress');
    expect(res.body.progress).toHaveProperty('totalRows');
    expect(res.body.progress).toHaveProperty('processedRows');
    expect(res.body.progress).toHaveProperty('percentage');
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body).toHaveProperty('completedAt');
  });
});

// ── GET /exports/:id/download ─────────────────────────────────────────────────
describe('GET /exports/:id/download', () => {
  test('returns 404 for unknown exportId', async () => {
    const res = await request(app).get('/exports/00000000-0000-4000-8000-000000000000/download');
    expect(res.status).toBe(404);
  });

  test('returns 425 Too Early when job is still pending', async () => {
    const createRes = await request(app).post('/exports/csv');
    const { exportId } = createRes.body;

    // Immediately try to download (job hasn't finished yet)
    const res = await request(app).get(`/exports/${exportId}/download`).timeout(3000)
      .catch((err) => err.response || { status: 500 });
    expect([425, 404]).toContain(res.status);
  });
});

// ── DELETE /exports/:id ───────────────────────────────────────────────────────
describe('DELETE /exports/:id', () => {
  test('returns 404 for unknown exportId', async () => {
    const res = await request(app).delete('/exports/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  test('returns 204 and job is no longer accessible', async () => {
    const createRes = await request(app).post('/exports/csv');
    const { exportId } = createRes.body;

    const delRes = await request(app).delete(`/exports/${exportId}`);
    expect(delRes.status).toBe(204);

    // Job should now 404
    const statusRes = await request(app).get(`/exports/${exportId}/status`);
    expect(statusRes.status).toBe(404);
  });
});

// ── 404 for unknown routes ────────────────────────────────────────────────────
describe('Unknown routes', () => {
  test('returns 404 for unknown path', async () => {
    const res = await request(app).get('/unknown-path');
    expect(res.status).toBe(404);
  });
});
