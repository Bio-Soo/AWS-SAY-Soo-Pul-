# Deployment Guide

End-to-end deployment of Soo-Pul to a fresh AWS account. Total time: ~2 hours (mostly waiting on Aurora cluster + initial Lambda layer builds).

---

## Step 0 — Prerequisites

| Tool | Version |
|---|---|
| AWS CLI v2 | latest |
| AWS SAM CLI | ≥ 1.100 |
| Docker | for `sam build --use-container` |
| Node.js | 18+ (for frontend) |
| Python | 3.11 (matches Lambda runtime) |
| psql | for DDL apply (optional — can use RDS Data API) |

You also need:
- An AWS account with admin privileges (or a tightly-scoped IAM user)
- Bedrock model access enabled in `ap-northeast-2` (apply via Bedrock console)
- A Cognito User Pool (or accept the bootstrap script creating one)

---

## Step 1 — Configure `.env`

```bash
cp .env.example .env
# Open .env and fill in real values for:
#   AWS_ACCOUNT_ID, AURORA_*, COGNITO_*, S3_BUCKET, VPC_ID, LAMBDA_SUBNET_IDS, LAMBDA_SECURITY_GROUP
```

---

## Step 2 — Bootstrap infrastructure

> If you already have Aurora + Cognito + VPC, skip this and just set them in `.env`.

```bash
./scripts/bootstrap-infra.sh
```

This provisions (in your account, your region):
- VPC (10.0.0.0/24) with 3 private subnets in 2 AZs, NAT gateway, IGW
- Security group for Aurora (5432 ingress from Lambda SG only)
- S3 bucket with SSE-AES256 default (CloudFront-compatible)
- Aurora PostgreSQL 16.4 cluster (db.serverless v2, min 0.5 ACU)
- Secrets Manager entries — `soopul/aurora/master` + `soopul/aurora/app-user`
- Cognito User Pool + App Client (no client secret)
- ACM cert (optional, if you have a custom domain)

Outputs are written to `.deployment-state.json` and consumed by later scripts.

---

## Step 3 — Apply database schema

```bash
./scripts/apply-ddl.sh
```

This runs the SQL files in [`database/ddl/`](./database/ddl/) in order:
1. `4-layer-schema-ddl-v1.sql` — main schema (`soopulai` schema + 20+ tables)
2. `system-log-schema-ddl.sql` — `phase_execution_log` + views
3. `phase5_lr_v4_addons.sql` — `top_lr_score`, `audit_trail`, etc.

Uses the master secret to apply DDL. For schema-only updates, prefer Liquibase/Flyway.

---

## Step 4 — Deploy Lambdas (6 functions + 7 layers)

```bash
./scripts/deploy-all-lambdas.sh
```

Order matters because of layer dependencies:
1. **`phase1-symptom`** — SAM, includes deps layer (Bedrock SDK, requests)
2. **`phase2-vision`** — single-file Lambda (no SAM), `update-function-code`
3. **`phase3-scorer`** — SAM, deps layer (lung_dx + pandas + openpyxl, ~33 MB)
4. **`phase4-verifier`** — SAM, deps layer (lung_dx + bedrock)
5. **`phase5-lr`** — SAM, deps layer (LIRICAL LR computation + pronto)
6. **`report-rag`** — SAM, deps layer (PubMed + Orphanet API clients)

⚠️ **Phase 3/4 deps layer must include `lung_disease_profiles_v3_6.yaml`** in `/opt/python/data/`. Layer build script downloads from `s3://your-bucket/database/lung_disease_profiles_v3_6.yaml`.

**VPC config** — all Lambdas (except phase1, which doesn't touch DB) need:
- Subnets with NAT egress (for Secrets Manager + Bedrock)
- Security group with Aurora 5432 ingress

The deploy script sets this from `.env`.

---

## Step 5 — Deploy Step Functions

```bash
./scripts/deploy-stepfunctions.sh
```

Reads [`stepfunctions/pipeline.asl.json`](./stepfunctions/pipeline.asl.json), substitutes Lambda ARNs from `.env`, creates the SFN role with `lambda:InvokeFunction` permission for all 6 Lambdas, then creates/updates the state machine.

State graph:
```
Start
  ├─ Phase1Symptom ─┐
  └─ Phase2Xray    ─┴─→ Phase3Scorer → Phase4Verifier → Phase5LR → RAGSynthesis → End
```

---

## Step 6 — Deploy frontend

```bash
cd frontend
npm install
npm run build      # outputs to dist/

# CRITICAL: --sse AES256 (S3 bucket default is aws:kms, but CloudFront OAC has no KMS perm)
aws s3 sync dist/ s3://$S3_BUCKET/frontend/ --delete --sse AES256

aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/*"
```

The frontend reads Cognito Pool ID + Client ID from `.env.production` at build time. Update `frontend/.env.production` before `npm run build`.

CloudFront distribution must have:
- Default origin: S3 bucket with origin path `/frontend`
- Behavior for `/api/*` → EC2 FastAPI origin (HTTP:8000, http-only)
- Behavior for `/ws/*` → same EC2 (WebSocket support)

See [`infra/cloudfront/distribution-config.json`](./infra/cloudfront/distribution-config.json) for a template.

---

## Step 7 — Deploy backend (FastAPI on EC2)

```bash
./scripts/deploy-backend.sh
```

This:
1. Provisions an EC2 instance (t3.medium, in your VPC public subnet, with EIP)
2. Installs Python 3.12 + uvicorn + dependencies via cloud-init
3. Rsyncs `backend/` to `/srv/soonet-pulmonary/`
4. Installs systemd unit (`soonet-api.service`) from [`backend/systemd/soonet-api.service`](./backend/systemd/soonet-api.service)
5. Sets up `/etc/soonet-api/db.env` with `DATABASE_URL` (asyncpg format)
6. Enables + starts the service

After deploy, smoke test:
```bash
curl https://$CLOUDFRONT_DOMAIN/health
# → {"status":"ok","service":"soonet-pulmonary-backend"}
```

---

## Step 8 — Seed mock data (for demo)

```bash
./scripts/seed-mock-emr.sh
```

Uploads:
- `s3://$S3_BUCKET/mock-emr/worklist.json` — 30 demo patients
- `s3://$S3_BUCKET/mock-emr/fhir/<patient_id>.json` — per-patient FHIR bundle
- DB rows: `patient_profile`, `raw_emr_bundle`, `imaging_study` for demo patients
- Cognito seed users (5 doctors) via `frontend/docs/cognito_seed.py`

---

## Step 9 — End-to-end verification

```bash
./scripts/verify-e2e.sh
```

Runs through the full flow as if a doctor were using the app:
1. `POST /api/v1/sessions` with a seeded patient
2. `POST /api/v1/sessions/{id}/run` — starts SFN
3. Polls `/api/v1/sessions/{id}` every 6s until `status=completed`
4. `GET /api/v1/sessions/{id}/result` — fetches final report
5. Asserts: all 5 phases populated, `markdown_report` length > 1000, ≥ 1 citation

Expected duration: ~120 s (Phase 1+2 parallel ≈ 10s, Phase 3 ≈ 13s, Phase 4 ≈ 20s, Phase 5 LR ≈ 8s, RAG ≈ 60s).

---

## Identifiers you must change

See [`docs/IDENTIFIERS_TO_REPLACE.md`](./docs/IDENTIFIERS_TO_REPLACE.md). The bootstrap + deploy scripts handle most of this via `.env` substitution, but a few hardcoded values in `lung_dx/` and `lambdas/*/lambda/handler.py` may need manual update if your AWS account differs significantly.

---

## Teardown

```bash
./scripts/teardown.sh    # Deletes ALL resources created by bootstrap-infra.sh + deploy-*.sh
```

⚠️ Aurora deletion takes ~15 minutes. CloudFront takes ~20 minutes to fully delete.
