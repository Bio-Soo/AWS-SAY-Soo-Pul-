# IAM Policies

Downloaded from the live AWS deployment on 2026-05-27. Use these as templates when creating equivalent roles in your account.

## Roles

| Role | Used by | Policies (inline) |
|---|---|---|
| `say2-2team-rare-link-stepfn-role` | Step Functions state machine | `say2-2team-rare-link-pipeline-policy` (lambda:InvokeFunction on all 6 phases + logs + xray) |
| `phase4-verifier-dev-Phase4VerifierFunctionRole-...` | Phase 4 Lambda | Bedrock (foundation model + APAC inference profile), Secrets Manager (soopul/aurora/app-user) |
| `phase5-rag-dev-Phase5RagFunctionRole-...` | report-rag Lambda | Bedrock, S3 (RAG cache + final reports), Secrets, KMS |
| `say2-2team-lambda-role` | Phase 2 + other shared Lambdas | Aurora Secrets, KMS, generic Lambda + VPC perms |

Trust policies (`*__trust.json`) allow `lambda.amazonaws.com` (or `states.amazonaws.com` for the SFN role) to assume.

## How to recreate in your account

```bash
ROLE="soonet-stepfn-role"
ACCOUNT="123456789012"

# 1. Create role with the trust policy
aws iam create-role --role-name $ROLE \
  --assume-role-policy-document file://say2-2team-rare-link-stepfn-role__trust.json

# 2. Attach inline policies (replace ARNs with yours via sed)
sed -e "s|666803869796|$ACCOUNT|g" \
    say2-2team-rare-link-stepfn-role__say2-2team-rare-link-pipeline-policy.json \
  > /tmp/policy.json

aws iam put-role-policy --role-name $ROLE \
  --policy-name pipeline-invoke --policy-document file:///tmp/policy.json
```

The deploy scripts (`scripts/deploy-stepfunctions.sh`, `scripts/deploy-all-lambdas.sh`) automate this.

## Attached managed policies

All Lambda roles also have:
- `arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole` (CloudWatch logs)
- `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole` (ENI create/delete)
- `arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess` (X-Ray tracing)

## Key learning — Bedrock IAM

The Phase 4 policy has both:
- `arn:aws:bedrock:ap-northeast-2::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0` (direct)
- `arn:aws:bedrock:ap-northeast-2:ACCOUNT:inference-profile/apac.anthropic.claude-3-5-sonnet-20241022-v2:0`

Inference profile invocation requires BOTH. The wildcard region `arn:aws:bedrock:*::foundation-model/...` lets the same policy work across regions if the inference profile is cross-region.
