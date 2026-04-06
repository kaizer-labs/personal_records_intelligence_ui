# Personal Records Intelligence UI

React frontend for the Personal Records Intelligence MVP.

## What Exists Today

- Vite + React + TypeScript template
- dashboard page that calls the backend `health_check` endpoint
- Dockerfile for local development

## Run Locally

From inside the API repo:

```bash
cd ../personal_records_intelligence_api
docker compose up --build ui
```

Then open `http://localhost:5173`.

## Expected Backend

The UI expects the backend to expose:

- `GET /health_check`

During Docker development, Vite proxies `/health_check` to the `api` service automatically.
