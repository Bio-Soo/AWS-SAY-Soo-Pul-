# Identifiers to replace when forking

When you deploy Soo-Pul to a fresh AWS account, the following hardcoded identifiers reference the original team's environment (account `666803869796`, region `ap-northeast-2`). Most are read from `.env` by the deploy scripts, but a few are baked into source files.

## Read from `.env` (auto-substituted at deploy)
- AWS_ACCOUNT_ID
- S3_BUCKET (`say2-2team-bucket` → yours)
- AURORA_CLUSTER_ENDPOINT (`patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com`)
- COGNITO_USER_POOL_ID (`ap-northeast-2_CMtZTRCTa`)
- COGNITO_CLIENT_ID
- CLOUDFRONT_DISTRIBUTION_ID (`E2ZHONIV05TX9D`) + CLOUDFRONT_DOMAIN (`d300v14l8u0wx7.cloudfront.net`)
- VPC_ID (`vpc-06dd0ad1f2335ea74`) + LAMBDA_SUBNET_IDS + LAMBDA_SECURITY_GROUP
- EC2_INSTANCE_ID
- STEPFN ARN (constructed from `STEPFN_NAME` + AWS_ACCOUNT_ID + region)

## Hardcoded in source — manual replace required

These currently reference the original deployment. Find/replace before deploying:

| File | Identifier | Replacement |
|---|---|---|
| `lambdas/phase3-scorer/lambda/handler.py` | `patient-db-cluster.cluster-cxmiyawwwhbt...` | `$AURORA_CLUSTER_ENDPOINT` |
| `lambdas/phase4-verifier/lambda/handler.py` | (same) | (same) |
| `lambdas/phase5-lr/lambda/handler.py` + `db_reader.py` | (same) | (same) |
| `lambdas/report-rag/lambda/rag_llm_3.py` | (same) | (same) |
| `lambdas/phase2-vision/lambda/phase2_handler.py` | (same) | (same) |
| `lambdas/*/template.yaml` | `BEDROCK_REGION`, `BEDROCK_MODEL_ID` | adjust to your Bedrock-enabled region + model access |
| `frontend/.env.production` | Cognito Pool ID, API base URL | from your `.env` |
| `frontend/src/auth/cognito.js` | Cognito region/user pool | imports from `.env.production` (already wired) |
| `backend/api/app/config.py` | Default Aurora endpoint | reads from env, but defaults to old host |
| `backend/api/shared/db_models.py` | `SCHEMA = "soopulai"` | OK as-is unless you want a different schema name |

### Recommended one-shot find/replace

```bash
# From repo root, after .env is filled in:
./scripts/apply-config.sh
```

This script does a project-wide find/replace driven by `.env`. It rewrites:
- `666803869796` → `$AWS_ACCOUNT_ID`
- `patient-db-cluster.cluster-cxmiyawwwhbt...` → `$AURORA_CLUSTER_ENDPOINT`
- `say2-2team-bucket` → `$S3_BUCKET`
- `vpc-06dd0ad1f2335ea74` → `$VPC_ID`
- ...etc.

Run once after cloning, then commit the customized version to your own fork.

---

## Bedrock model IDs (region-specific)

These are NOT find-replaceable — they encode Bedrock model availability per region. If you deploy outside `ap-northeast-2`:

| Region | Phase 4 recommended | RAG recommended |
|---|---|---|
| `ap-northeast-2` (Seoul) | `apac.anthropic.claude-3-5-sonnet-20241022-v2:0` | `anthropic.claude-3-5-sonnet-20240620-v1:0` |
| `us-east-1` | `us.anthropic.claude-sonnet-4-6` | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `eu-central-1` | `eu.anthropic.claude-3-5-sonnet-20240620-v1:0` | (same) |

You must also grant the Lambda IAM role `bedrock:InvokeModel` on both the inference-profile ARN and the underlying foundation-model ARNs. See [`infra/iam/phase4-bedrock-policy.json`](../infra/iam/) for the template.

---

## SageMaker endpoint (Phase 2)

Phase 2 invokes a SageMaker endpoint for the 14-class DenseNet CXR classifier. Environment variable: `SAGEMAKER_ENDPOINT`. The model artifacts (`anatomy_soonet_v5_best.pth`, `latest_checkpoint.pth`, `unet_lung_heart_ep5.pth`) are not included in this repo (too large — ~200 MB+ each). Download them separately or train your own:

```bash
# If you have access to the original team's S3:
aws s3 cp s3://say2-2team-bucket/Phase_2/anatomy_soonet_v5_best.pth ./models/
aws s3 cp s3://say2-2team-bucket/Phase_2/latest_checkpoint.pth ./models/
```

Otherwise, see [`lambdas/phase2-vision/README.md`](../lambdas/phase2-vision/) for training instructions.
