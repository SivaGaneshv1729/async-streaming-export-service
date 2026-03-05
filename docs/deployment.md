# Deployment Guide

This project is fully containerized using Docker and Docker Compose, fulfilling the requirement for a Reproducible, isolated environment.

## Multi-container Architecture

The `docker-compose.yml` spins up 3 services inside a private bridge network (`export-net`).

### 1. The PostgreSQL Database (`db`)

- **Image**: `postgres:15`
- **Port**: Exposes `5433` on the host mapped to `5432` inside the container.
- **Initialization**: Mounts the `./seeds` directory so that `init.sql` executes upon first creation.
- **Persistence**: Reuses a Docker volume `pg_data` to ensure the 10-million row database isn't purged on restarts.
- **Healthcheck**: Periodically polls `pg_isready` so that dependent services wait before trying to connect.

### 2. The Redis Queue (`redis`)

- **Image**: `redis:7-alpine`
- **Role**: Provides the fast, in-memory store needed by `BullMQ` to manage worker threads, track `exportId`s, and maintain the queue state. Note that if the Node Application crashes, the Queue remains intact.
- **Healthcheck**: Uses the standard `redis-cli ping`.

### 3. The Node.js Application (`app`)

- **Image**: Built dynamically from the raw `Dockerfile`.
- **Memory Limit Execution**: The hardest core requirement was guaranteeing low memory consumption. `docker-compose.yml` ensures this using the deploy key:
  ```yaml
  mem_limit: 150m
  ```
- **Dependencies**: Explicitly uses `depends_on: { db: ..., redis: ... }` with the `condition: service_healthy` flag to guarantee it boots only once the database is fully seeded and Redis is awake.

## Dockerfile Design

The included `Dockerfile` uses **Multi-stage builds** to compile the Node.js application securely.

- **Builder Stage**: Copies the `package.json` files and runs `npm ci` (or `npm install`) to fetch `express`, `pg`, `csv-stringify`, and `bullmq`.
- **Runner Stage**:
  1. Uses an alpine linux base image.
  2. Enforces security by creating and swapping to a non-root linux user named `appuser` so the container runs safely.
  3. Copies only the built node artifacts.
  4. Automatically serves the API on port 8080.

## Running the Project

```bash
# Provide environment variables (DB URLs, API Ports)
cp .env.example .env

# Start all three services in detached mode
docker-compose up --build -d
```

### Checking for Limits and Memory Leaks

To prove the project is meeting the memory constraints under an active 10 million row export:

```bash
docker stats async-streaming-export-app --no-stream
```

The `MEM USAGE / LIMIT` column should report something around `40MiB / 150MiB`.
