#!/usr/bin/env bash
# Deploy all 6 Lambdas (Phase 1, 2, 3, 4, 5-LR, report-rag).
# Run from repo root. Requires AWS CLI + SAM CLI + Docker.

set -euo pipefail
[ -f .env ] || { echo "ERROR: .env not found. Copy .env.example → .env and fill in values."; exit 1; }
source .env

cd "$(dirname "$0")/.."

ROOT=$(pwd)
TAG="${TAG:-project=soonet-pulmonary}"

deploy_sam() {
  local dir="$1" stack="$2" label="$3"
  echo ""
  echo "═══════════════════════════════════════════"
  echo " [$label] $stack"
  echo "═══════════════════════════════════════════"
  cd "$ROOT/lambdas/$dir"

  if [ -x layer/build_layer.sh ]; then
    echo "[layer] building..."
    ./layer/build_layer.sh
  fi

  sam build --use-container
  sam deploy --region "$AWS_REGION" --stack-name "$stack" \
    --parameter-overrides \
        Stage=dev \
        S3Bucket="$S3_BUCKET" \
        AuroraEndpoint="$AURORA_CLUSTER_ENDPOINT" \
        SecretAuroraAppUser="$SECRET_AURORA_APP_USER" \
        VpcSubnetIds="$LAMBDA_SUBNET_IDS" \
        VpcSecurityGroupId="$LAMBDA_SECURITY_GROUP" \
        BedrockRegion="$BEDROCK_REGION" \
        BedrockModelId="${BEDROCK_MODEL_PHASE4:-anthropic.claude-3-5-sonnet-20240620-v1:0}" \
        SageMakerEndpoint="${SAGEMAKER_ENDPOINT:-}" \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset --resolve-s3 \
    --no-fail-on-empty-changeset \
    --tags "$TAG"
  cd "$ROOT"
}

deploy_phase2_no_sam() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo " [2/6] phase2-vision (no SAM, direct update)"
  echo "═══════════════════════════════════════════"
  cd "$ROOT/lambdas/phase2-vision"
  zip -q /tmp/phase2.zip lambda/phase2_handler.py
  aws lambda update-function-code \
    --function-name say2-2team-phase2-vision \
    --zip-file fileb:///tmp/phase2.zip \
    --query '[FunctionName,LastUpdateStatus]' --output text
  cd "$ROOT"
}

deploy_sam "phase1-symptom"     "phase1-symptom-dev"   "1/6"
deploy_phase2_no_sam
deploy_sam "phase3-scorer"      "phase3-scorer-dev"    "3/6"
deploy_sam "phase4-verifier"    "phase4-verifier-dev"  "4/6"
deploy_sam "phase5-lr"          "phase5-lr-dev"        "5/6"
deploy_sam "report-rag"         "report-rag-dev"       "6/6"

echo ""
echo "✓ All Lambdas deployed."
aws lambda list-functions --region "$AWS_REGION" \
  --query "Functions[?contains(FunctionName,'phase') || contains(FunctionName,'report-rag')].[FunctionName,LastModified,Runtime]" \
  --output table
