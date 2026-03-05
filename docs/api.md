# API Documentation

The Async Streaming Export Service provides a RESTful API to trigger, monitor, and download massive datasets.

## Endpoints

### 1. Initiate Export

**`POST /exports/csv`**

Triggers a background worker to extract data matching the optional filters and format it into a CSV file.

**Query Parameters:**

- `columns` (string, optional): Comma separated list of columns. Default is all columns.
- `country_code` (string, optional): 2-letter ISO country code.
- `subscription_tier` (string, optional): `free`, `basic`, `premium`, `enterprise`.
- `min_ltv` (number, optional): Minimum lifetime value.
- `delimiter` (char, optional): CSV delimiter. Default is `,`.
- `quoteChar` (char, optional): CSV quote character. Default is `"`.

**Success Response (202 Accepted):**

```json
{
  "exportId": "52951408-6bb2-4e79-9c20-b1438578d02a",
  "status": "pending"
}
```

---

### 2. Check Status

**`GET /exports/:id/status`**

Polls the Redis queue for the real-time progress of an export.

**Success Response (200 OK):**

```json
{
  "exportId": "52951408-6bb2-4e79-9c20-b1438578d02a",
  "status": "processing",
  "progress": {
    "totalRows": 150000,
    "processedRows": 75000,
    "percentage": 50
  },
  "error": null,
  "createdAt": "2026-03-05T19:00:00.000Z",
  "completedAt": null
}
```

---

### 3. Download File

**`GET /exports/:id/download`**

Serves the completed CSV file. This endpoint supports **Resumable Downloads** and **On-the-fly Gzip compression**.

**Headers Supported:**

- `Range: bytes=0-1024` (For paused/resumed downloads).
- `Accept-Encoding: gzip` (Streams the file through a `zlib` compression pipe on-the-fly to save bandwidth).

**Response (200 OK or 206 Partial Content):**

- Returns a standard stream. If the job is not yet finished, returns `425 Too Early`.

---

### 4. Cancel Job

**`DELETE /exports/:id`**

Aborts an ongoing export job.

**Behavior:**

- Triggers a cancellation signal to the BullMQ worker.
- The worker stops querying the database and destroys the output stream.
- Deletes the partially generated `export_{id}.csv` from disk to reclaim space.

**Response:** Returns `204 No Content`.

---

### 5. Health Check

**`GET /health`**

Monitors the uptime of the Node.js API container. Always returns instantly, even if a heavy export is utilizing the CPU, proving that the async event-loop is not blocked.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-03-05T19:00:00.000Z"
}
```
