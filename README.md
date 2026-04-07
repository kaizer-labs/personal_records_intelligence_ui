# Personal Records Intelligence UI

React frontend for the Personal Records Intelligence MVP.

## What This Repo Contains

- Vite + React + TypeScript app
- conversation-first records workspace
- library and conversation views
- evidence drawer and streaming answer UI
- Dockerfile used by the API repo's compose stack

## How To Run It

The UI is started through the API repo so it can talk to the FastAPI service.

```bash
cd /Users/kaizer/Desktop/personal_records_intelligence/personal_records_intelligence_api
docker compose up --build ui
```

If the API is not already running, start the full stack instead:

```bash
docker compose up --build
```

Then open:

- `http://localhost:5173`

## Expected Backend

During Docker development, the UI expects the API service from the sibling repo and talks to it through the Vite proxy.

Common endpoints used by the UI include:

- `GET /health_check`
- `GET /api/library/folders`
- `POST /api/library/examples/sync`
- `POST /api/library/folders/sync`
- `POST /api/chat/answers/stream`

## Notes

- The UI repo does not store local records itself.
- Indexed files and DuckDB data live in the API repo under `data/`.
