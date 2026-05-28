# Soo-Pul Backend (FastAPI on EC2)

REST + WebSocket API for the diagnosis pipeline.

## Local dev
```bash
cd backend
pip install -r requirements.txt
cp systemd/db.env.example .env
# edit .env with your Aurora URL etc.
export $(cat .env | xargs)
uvicorn api.app.main:app --reload --port 8000
```

Open http://localhost:8000/docs for API reference.

## Production deploy
Run `./scripts/deploy-backend.sh` from repo root. It SSM RunCommand-deploys to the EC2 instance set in `.env`.

## systemd unit
Install path: `/etc/systemd/system/soonet-api.service`
Env file:     `/etc/soonet-api/db.env`  (chmod 600)

## Endpoints
- `GET  /health` — liveness
- `POST /api/v1/sessions` — create diagnosis session
- `POST /api/v1/sessions/{id}/run` — start SFN pipeline
- `GET  /api/v1/sessions/{id}` — poll progress (frontend polls every 2s)
- `GET  /api/v1/sessions/{id}/result` — final report (only when status=completed)
- `GET  /api/v1/worklist?date=YYYY-MM-DD` — today's patients
- `POST /api/v1/feedback` — doctor feedback on diagnosis
- `WS   /ws/emr-updates` — real-time EMR updates
