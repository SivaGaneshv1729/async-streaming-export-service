# Large-Scale CSV Export Service with Async Streaming and Progress Tracking

A high-performance Node.js service that **asynchronously exports millions of PostgreSQL rows to CSV** with progress tracking, resumable downloads, gzip compression, column selection, and custom CSV formatting — all within a **150 MB memory limit**.

---

## Features

| Feature                    | Details                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Async job model**        | `POST` returns immediately with a job ID; export runs in the background        |
| **Progress tracking**      | Live `processedRows`, `totalRows`, `percentage` via polling                    |
| **Cursor-based streaming** | Fetches rows in configurable batches (`DB_CURSOR_BATCH_SIZE`), O(batch) memory |
| **Back-pressure handling** | Awaits `drain` events to prevent unbounded buffering                           |
| **Resumable downloads**    | HTTP `Range` / `206 Partial Content` support                                   |
| **On-the-fly gzip**        | Pass `Accept-Encoding: gzip` on download                                       |
| **Column selection**       | `?columns=id,email,country_code`                                               |
| **Custom CSV formatting**  | `?delimiter=\|` and `?quoteChar='` (Escaped pipe)                              |
| **Filtering**              | `country_code`, `subscription_tier`, `min_ltv`                                 |
| **Job cancellation**       | `DELETE /exports/:id` stops the worker and removes the file                    |
| **10M row dataset**        | Auto-seeded on first start via pure-SQL `generate_series`                      |

---

## Quick Start

```bash
# 1. Copy env file
cp .env.example .env

# 2. Start all services (DB seeding takes ~3-5 min for 10M rows)
docker-compose up --build -d

# 3. Watch logs
docker-compose logs -f app

# 4. Health check
curl http://localhost:8080/health
```

> **Note**: Wait until the `db` container log shows `[init] Seeding complete – 10,000,000 rows inserted.` before running exports.

---

## API Reference

### POST /exports/csv

Initiate a background export job.

**Query Parameters** (all optional):

| Parameter           | Type   | Example                   | Description                                               |
| ------------------- | ------ | ------------------------- | --------------------------------------------------------- |
| `country_code`      | string | `US`                      | Filter by 2-letter country code                           |
| `subscription_tier` | string | `premium`                 | Filter by tier (`free`, `basic`, `premium`, `enterprise`) |
| `min_ltv`           | number | `500.00`                  | Filter users with `lifetime_value ≥ value`                |
| `columns`           | string | `id,email,lifetime_value` | Comma-separated columns to export (default: all)          |
| `delimiter`         | char   | `\|`                      | Field separator (default: `,`)                            |
| `quoteChar`         | char   | `'`                       | Quote character (default: `"`)                            |

**Response `202`**:

```json
{ "exportId": "uuid", "status": "pending" }
```

---

### GET /exports/{exportId}/status

Poll export progress.

**Response `200`**:

```json
{
  "exportId": "uuid",
  "status": "pending | processing | completed | failed | cancelled",
  "progress": {
    "totalRows": 1000000,
    "processedRows": 543000,
    "percentage": 54
  },
  "error": null,
  "createdAt": "2026-03-04T10:00:00.000Z",
  "completedAt": null
}
```

---

### GET /exports/{exportId}/download

Download the completed CSV file.

- Returns `425 Too Early` if still processing
- Returns `404` if job not found or failed

**Headers**:

- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="export_{id}.csv"`
- `Accept-Ranges: bytes`
- `Content-Length: <bytes>`

**Resumable download**:

```bash
curl -H "Range: bytes=0-1023" http://localhost:8080/exports/{id}/download
# → 206 Partial Content
```

**Gzip download**:

```bash
curl -H "Accept-Encoding: gzip" http://localhost:8080/exports/{id}/download | gunzip > export.csv
```

---

### DELETE /exports/{exportId}

Cancel and remove an export job.

- Returns `204 No Content`
- Stops the background worker cooperatively
- Deletes any partial file from disk

---

### GET /health

```json
{ "status": "ok", "timestamp": "2026-03-04T10:00:00.000Z" }
```

---

## Project Structure

```
async-streaming-export-service/
├── Dockerfile                  # Multi-stage build, non-root user
├── docker-compose.yml          # App (150m mem) + PostgreSQL 15 + Redis
├── .env.example                # All required environment variables
├── .gitignore
├── README.md
├── docs/                       # Detailed Documentation
│   ├── architecture.md         # Architecture flowchart & backpressure concept
│   ├── api.md                  # REST Endpoint specifications
│   ├── database.md             # ERD and Indexing decisions
│   └── deployment.md           # Docker multi-container scaling guide
├── seeds/
│   └── init.sql                # Schema + 10M row seed via generate_series
├── source_code/
│   ├── package.json
│   └── src/
│       ├── index.js            # Express entry point
│       ├── db.js               # pg Pool + cursor AsyncGenerator
│       ├── queue.js            # BullMQ Redis Queue manager
│       ├── worker.js           # Background streaming + progress updates
│       └── routes/
│           ├── exports.js      # All /exports/* endpoints
│           └── health.js       # GET /health
└── tests/
    └── api.test.js             # Jest + supertest
```

---

## Environment Variables

| Variable               | Default        | Description                       |
| ---------------------- | -------------- | --------------------------------- |
| `API_PORT`             | `8080`         | Port the app listens on           |
| `DATABASE_URL`         | —              | Full PostgreSQL connection string |
| `DB_HOST`              | `db`           | PostgreSQL host                   |
| `DB_PORT`              | `5432`         | PostgreSQL port                   |
| `DB_USER`              | `exporter`     | PostgreSQL user                   |
| `DB_PASSWORD`          | `secret`       | PostgreSQL password               |
| `DB_NAME`              | `exports_db`   | Database name                     |
| `EXPORT_STORAGE_PATH`  | `/app/exports` | Directory for CSV files           |
| `DB_CURSOR_BATCH_SIZE` | `1000`         | Rows per cursor batch             |

---

## Running Tests

```bash
cd source_code
npm install
npm test
```

---

## Memory Verification

```bash
# Start a large export then watch memory
curl -X POST "http://localhost:8080/exports/csv"
docker stats async-streaming-export-app --no-stream
# Should stay well under 150 MB
```

---

## Architecture

For a deep dive into how compiling **Backpressure**, **Stateless Keyset Pagination**, and **Redis/BullMQ Background workers** resolves OOM crashes for massive datasets, please read the [Architecture Documentation](./docs/architecture.md).
