# Soo-Pul (SooNet-Pulmonary)

> Rare pulmonary disease diagnostic support — multi-phase AI pipeline for clinicians

End-to-end Clinical Decision Support system that takes a patient's EMR record + chest X-ray and produces a ranked rare-disease differential diagnosis with LLM-verified citations.

**Team:** SKKU AWS SAY 2nd cohort, Team 2 · **License:** Internal / educational use

---

## What's inside

```
soonet-pulmonary/
├── frontend/                   # React + Vite SPA — deploys to S3 + CloudFront
├── backend/                    # FastAPI (uvicorn on EC2) — orchestration API
├── lambdas/                    # 6 AWS Lambda functions (Phase 1-5 + RAG report)
│   ├── phase1-symptom/         # Symptom text → HPO codes (Bedrock Claude)
│   ├── phase2-vision/          # CXR → 14 DenseNet labels (SageMaker endpoint)
│   ├── phase3-scorer/          # 4-axis weighted scoring across 474 diseases
│   ├── phase4-verifier/        # Bedrock LLM re-rank + 6 guard rails
│   ├── phase5-lr/              # LIRICAL LR scoring for rare-disease listing
│   └── report-rag/             # External-API RAG → final clinical report
├── layers/                     # Lambda layer zips (deps + data)
├── lung_dx/                    # Shared Python library (used by phase3, 4)
├── stepfunctions/              # Step Functions ASL definition
├── infra/
│   ├── iam/                    # IAM role policies (JSON)
│   ├── vpc/                    # VPC, subnet, SG documentation
│   └── cloudfront/             # CloudFront distribution config
├── database/
│   ├── ddl/                    # Aurora PostgreSQL schema DDL
│   └── seed/                   # Seed data scripts (mock EMR, imaging_study)
├── scripts/                    # deploy-all, verify-e2e, teardown
└── docs/                       # Architecture, runbooks
```

---

## Architecture (1-paragraph)

Doctor opens the **frontend** (CloudFront → S3) and authenticates via **Cognito**. Clicking a patient calls the **FastAPI backend** on EC2, which (a) creates a `diagnosis_session` row in **Aurora PostgreSQL** and (b) starts a **Step Functions** execution. The pipeline runs `Phase 1 (HPO extraction)` and `Phase 2 (CXR DenseNet)` in parallel → `Phase 3 (4-axis scoring)` → `Phase 4 (Bedrock LLM verification)` → `Phase 5 LR (LIRICAL rare-disease listing)` → `RAG (external KB + Bedrock report synthesis)`. Each phase persists results to its own table; the frontend polls `/api/v1/sessions/{id}` every 2 s and renders progress. Final output: a markdown clinical report with PMID citations.

```
User → Frontend (CloudFront/S3)
        ↓
    FastAPI (EC2:8000)  ←→  Aurora PostgreSQL (soopul.soopulai)
        ↓
    Step Functions ──┬─→ Phase 1: Symptom → HPO  (Bedrock)
                     ├─→ Phase 2: CXR → DenseNet (SageMaker)
                     └─→ Phase 3 → Phase 4 → Phase 5 LR → RAG
                                                              ↓
                                                       Final report
```

---

## Quickstart (deploy from scratch)

**Prereqs:** AWS account, AWS CLI configured, Node 18+, Python 3.11+, Docker (for SAM build).

```bash
# 1. Configure your environment
cp .env.example .env
# Edit .env — fill in AWS_ACCOUNT_ID, AURORA endpoint, Cognito Pool IDs, etc.

# 2. Provision foundational AWS resources
./scripts/bootstrap-infra.sh        # VPC, RDS, Cognito, Secrets Manager, S3

# 3. Apply database schema
./scripts/apply-ddl.sh

# 4. Deploy all Lambdas
./scripts/deploy-all-lambdas.sh

# 5. Deploy Step Functions
./scripts/deploy-stepfunctions.sh

# 6. Deploy frontend
cd frontend && npm install && npm run build
aws s3 sync dist/ s3://<your-bucket>/frontend/ --sse AES256
aws cloudfront create-invalidation --distribution-id <YOUR_DIST_ID> --paths "/*"

# 7. Deploy backend FastAPI to EC2
./scripts/deploy-backend.sh

# 8. End-to-end verification
./scripts/verify-e2e.sh
```

See [`DEPLOY.md`](./DEPLOY.md) for the full step-by-step guide, including **identifiers you must change** (account ID, ARNs, Cognito Pool IDs, etc.).

---

## Notable design choices

- **Inference profile required** for Bedrock Claude in `ap-northeast-2` — on-demand foundation model invocation is rejected. Lambdas use `apac.anthropic.claude-3-5-sonnet-20241022-v2:0` or `anthropic.claude-3-5-sonnet-20240620-v1:0`.
- **VPC connectivity** — All Lambdas that touch Aurora **must** be in subnets with NAT egress (for Secrets Manager) AND with security group `sg-fhir-ec2` (only SG allowed to reach RDS:5432).
- **Lambda Layer split** — `*-deps-dev` contains Python packages + `lung_dx` source + reference YAML/JSON files. `*-data-dev` (legacy, optional) — most data lives in deps layer at `/opt/python/data/`.
- **Schema naming** — Database `soopul`, schema `soopulai` (renamed from `rarelink`/`rarelinkai` on 2026-05-26).

---

## Documentation

- [`DEPLOY.md`](./DEPLOY.md) — Full deployment runbook
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — Phase-by-phase data flow
- [`docs/IDENTIFIERS_TO_REPLACE.md`](./docs/IDENTIFIERS_TO_REPLACE.md) — All hardcoded values you must update before deploying to your own AWS account
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — Troubleshooting, common issues, recovery
- [`backend/api/README.md`](./backend/api/README.md) — FastAPI endpoint reference
- [`frontend/README.md`](./frontend/README.md) — Frontend build + deploy

---

## License

Internal use, SKKU AWS SAY 2nd cohort Team 2. Not for production clinical use without IRB/regulatory review.
