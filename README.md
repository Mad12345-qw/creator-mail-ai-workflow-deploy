# Creator Mail AI Workflow

Deploy-only backend for the creator collaboration email workflow.

This repository intentionally excludes customer documents, examples, and secrets.

## Endpoints

- `GET /health`
- `GET /cron/keepalive`
- `POST /webhook/feishu`
- `GET|POST /jobs/poll-email?token=CRON_SECRET`
