# Architecture

## Request flow (clinician opens worklist → final report)

```
┌────────────┐   HTTPS    ┌────────────┐
│  Browser   │───────────▶│ CloudFront │
└────────────┘            └─────┬──────┘
                                │
        ┌───────────────────────┼─────────────────────┐
        ▼ /                     ▼ /api/*, /ws/*       ▼ /assets/*
  ┌──────────┐            ┌──────────────┐      ┌──────────┐
  │ S3 (SPA) │            │ EC2 FastAPI  │      │   S3     │
  │ HTML/JS  │            │ uvicorn :8000│      │ /frontend│
  └──────────┘            └──────┬───────┘      └──────────┘
                                 │
                                 │ asyncpg
                                 ▼
                          ┌──────────────┐
                          │ Aurora PG    │
                          │ soopul/soopulai │
                          └──────┬───────┘
                                 │
                                 │ aws_sdk:start_execution
                                 ▼
            ┌──────────────────────────────────────────────┐
            │           AWS Step Functions                  │
            │                                                │
            │  ┌─────────────┐  ┌────────────┐              │
            │  │ Phase1Symp  │  │ Phase2Xray │  (parallel)  │
            │  │ Bedrock     │  │ SageMaker  │              │
            │  └──────┬──────┘  └──────┬─────┘              │
            │         └────────┬───────┘                    │
            │                  ▼                            │
            │          ┌─────────────┐                      │
            │          │ Phase3Scorer│  (lung_dx scoring)   │
            │          └──────┬──────┘                      │
            │                 ▼                             │
            │         ┌──────────────┐                      │
            │         │ Phase4Verif  │  (Bedrock guardrails)│
            │         └──────┬───────┘                      │
            │                ▼                              │
            │          ┌────────────┐                       │
            │          │ Phase5LR   │  (LIRICAL rare-dx)    │
            │          └──────┬─────┘                       │
            │                 ▼                             │
            │          ┌────────────┐                       │
            │          │ RAGSynth   │  (PubMed/Orpha + LLM) │
            │          └──────┬─────┘                       │
            │                 ▼                             │
            │           [Aurora]                            │
            │       final_report row                        │
            └──────────────────────────────────────────────┘
                              │
                              ▼  frontend polls every 2s
                       /api/v1/sessions/{id}
                       /api/v1/sessions/{id}/result
```

## Per-phase responsibility

| Phase | Input | Output | Storage | LLM/Model |
|---|---|---|---|---|
| **Phase 1: Symptom** | Korean symptom_text | positive/negative HPO codes | `phase1_hpo_extraction` | Bedrock Claude (Korean → HPO mapping) |
| **Phase 2: Vision** | CXR S3 key | 14-class probabilities + HPO codes | `phase2_xray_processing` | SageMaker DenseNet 14-class (SooNet v8) |
| **Phase 3: Scorer** | All Phase 1 + 2 + lab data | Top 10 disease candidates with 4-axis score | `phase3_integrated_ranking` | Rule-based (no LLM) — `lung_dx.diagnostic_scorer` |
| **Phase 4: Verifier** | Phase 3 ranking + raw findings | Re-ranked top diseases with confidence + evidence | `phase4_llm_rerank` | Bedrock Claude 3.5 Sonnet v2 + 6 guard rails |
| **Phase 5 LR** | All HPOs (Phase 1 + 2) | Rare disease likelihood ratios (LIRICAL) | `phase5_rare_disease_listing` | Rule-based (no LLM) — `lung_dx.phase5_lr` |
| **RAG Synthesis** | All previous results | Final markdown report + PDF | `final_report` | Bedrock Claude 3.5 Sonnet + PubMed/Orphanet/Monarch APIs |

## Database schema (key tables)

```
diagnosis_session       — session state (status, current_phase, phase_states JSONB)
patient_profile         — demographics
raw_emr_bundle          — FHIR Bundle JSON (1 row per encounter)
imaging_study           — CXR/CT studies with s3_uri_png
phase1_hpo_extraction   — positive_hpo[], negative_hpo[]
phase2_xray_processing  — densenet_findings JSONB, s3_original_full
phase3_integrated_ranking — ranking JSONB (top 10 dx with 4-axis scores)
phase4_llm_rerank       — reranked JSONB
phase5_rare_disease_listing — listed_diseases, total_listed_count, top_lr_score
final_report            — markdown_report, rag_citations, s3_uri_pdf
phase_execution_log     — observability: started/succeeded/failed per phase
rag_api_cache           — TTL cache for PubMed/Orphanet (cost saving)
```

## Key infrastructure decisions

### Why FastAPI on EC2 (not Lambda)?
- WebSocket support for EMR updates (`/ws/emr-updates`)
- Persistent asyncpg connection pool (Aurora cold-start penalty)
- Long-running SFN trigger + result polling
- Easier debugging (systemd journalctl > CloudWatch tail)

### Why 6 Lambdas, not 1 monolith?
- Independent scaling (Phase 2 vision is the bottleneck — separate concurrency)
- Independent IAM (Phase 4 needs Bedrock, Phase 2 needs SageMaker, others don't)
- Independent layers (`lung_dx` is 30 MB — only Phase 3/4 load it)
- Failure isolation (Phase 5 LR can fail without killing the SFN; RAG retries it)

### Why VPC subnets matter (lesson learned)
- All Aurora-accessing Lambdas must be in subnets with NAT egress (for Secrets Manager)
- Security group must allow outbound 5432 to Aurora SG
- If a Lambda lands in a subnet without NAT, **`SecretsManager.GetSecretValue()` silently hangs until Lambda timeout (default 5 min)** — not an obvious failure mode
- Lesson: explicit subnet whitelist in deploy script, never accept SAM defaults

### Why inference profiles for Bedrock?
- In `ap-northeast-2`, foundation models reject direct `on-demand` `InvokeModel`
- Must use APAC inference profile (`apac.anthropic.claude-3-5-sonnet-...`) OR a `*-20240620-v1:0` foundation model (these still work direct)
- IAM policy needs both inference-profile ARN AND underlying foundation-model ARN (cross-region wildcards work: `arn:aws:bedrock:*::foundation-model/...`)

## Sequence diagram (1 diagnosis)

```
Browser    FastAPI     Aurora       SFN          Phase1  Phase2  Phase3  Phase4  Phase5  RAG
  │           │           │           │             │       │       │       │       │      │
  │ POST /sessions       │           │             │       │       │       │       │      │
  │──────────▶│ INSERT diagnosis_session            │       │       │       │       │      │
  │           │──────────▶│           │             │       │       │       │       │      │
  │◀──{session_id}        │           │             │       │       │       │       │      │
  │           │           │           │             │       │       │       │       │      │
  │ POST /run │           │           │             │       │       │       │       │      │
  │──────────▶│ start_execution       │             │       │       │       │       │      │
  │           │──────────────────────▶│             │       │       │       │       │      │
  │◀──{exec_arn}          │           │             │       │       │       │       │      │
  │           │           │           │ parallel    │       │       │       │       │      │
  │           │           │           ├────────────▶│       │       │       │       │      │
  │           │           │           │             │       │       │       │       │      │
  │           │           │           ├────────────────────▶│       │       │       │       │
  │           │           │           │             │ INSERT phase1                  │      │
  │           │           │◀─────────────────────────┤       │       │       │       │      │
  │           │           │           │             │       │ INSERT phase2          │      │
  │           │           │◀──────────────────────────────────┤       │       │       │      │
  │ GET /sessions/{id}    │           │             │       │       │       │       │      │
  │──────────▶│ SELECT phase{1,2,3,4,5} │           │       │       │       │       │      │
  │◀──{progress:0.4...}   │           │             │       │       │       │       │      │
  │           │           │           │ chain       │       │       │       │       │      │
  │           │           │           ├──────────────────────────────▶│       │       │      │
  │           │           │           │             │       │       │ INSERT phase3 │      │
  │           │           │           │             │       │       │       ▶│      │      │
  │           │           │           │             │       │       │       │ INSERT p4    │
  │           │           │           │             │       │       │       │       ▶│     │
  │           │           │           │             │       │       │       │       │ INSERT p5│
  │           │           │           │             │       │       │       │       │       ▶│
  │           │           │           │             │       │       │       │       │       │ INSERT final_report
  │           │           │           │             │       │       │       │       │       │ UPDATE diagnosis_session status=completed
  │ GET /sessions/{id}    │           │             │       │       │       │       │       │
  │◀──{status:completed,progress:1.0} │             │       │       │       │       │       │
  │           │           │           │             │       │       │       │       │       │
  │ GET /sessions/{id}/result         │             │       │       │       │       │       │
  │◀──{markdown_report, citations, ...} (200 OK)    │       │       │       │       │       │
```

Total wall-clock: ~45-130 s depending on CXR processing + Bedrock latency.
