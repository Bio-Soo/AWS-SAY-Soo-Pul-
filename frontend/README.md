# Soo-Pul Frontend (React + Vite)

Clinician-facing SPA. Worklist, patient detail, diagnosis pipeline progress, final report viewer.

## Stack
- React 18, React Router 6
- Vite 5 (build tool)
- Tailwind CSS
- AWS Amplify (Cognito auth client)
- fhirclient (SMART on FHIR launch flow — `launch.html` + `app.html`)

## Local dev
```bash
cd frontend
cp .env.example .env.development
# fill VITE_COGNITO_* with dev pool values
npm install
npm run dev    # http://localhost:5173, proxies /api to localhost:8000
```

## Production build + deploy
Run from repo root: `./scripts/deploy-frontend.sh` — this:
1. Generates `.env.production` from root `.env`
2. `npm run build` → `dist/`
3. `aws s3 sync dist/ s3://$S3_BUCKET/frontend/ --sse AES256` (SSE-AES256 is **critical** — CloudFront OAC has no KMS access)
4. CloudFront invalidation

## Pages
- `index.html` — main SPA (worklist + diagnosis)
- `launch.html` — SMART on FHIR launch endpoint (called by EMR vendor)
- `app.html` — SMART on FHIR callback (token exchange)
