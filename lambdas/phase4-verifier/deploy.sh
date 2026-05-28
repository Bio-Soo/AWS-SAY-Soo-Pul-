#!/bin/bash
# Phase 4 SAM 배포
# Usage: ./deploy.sh [dev|staging|prod] [bedrock-region]
#   default: dev us-east-1

set -euo pipefail

STAGE="${1:-dev}"
REGION="${2:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "[phase4 deploy] stage=$STAGE bedrock_region=$REGION"

# ── 사전 점검: Bedrock 모델 액세스 ───────────────────────────────
echo "[phase4 deploy] checking Bedrock model access (Anthropic Claude Sonnet)..."
if ! aws bedrock list-foundation-models --region "$REGION" \
      --query "modelSummaries[?contains(modelId, 'claude-sonnet')].modelId" \
      --output text 2>/dev/null | grep -q claude-sonnet; then
  echo "[phase4 deploy] WARN: Bedrock 모델 액세스 확인 실패."
  echo "  AWS 콘솔 → Bedrock → Model access 에서 Anthropic Claude Sonnet 활성화 필요."
fi

# ── 1) Layer 빌드 ───────────────────────────────────────────────
./layer/build_layer.sh

# ── 2) SAM build ────────────────────────────────────────────────
echo "[phase4 deploy] sam build"
sam build --use-container

# ── 3) SAM deploy ───────────────────────────────────────────────
STACK_NAME="phase4-verifier-${STAGE}"
echo "[phase4 deploy] sam deploy stack=$STACK_NAME"
sam deploy \
  --stack-name "$STACK_NAME" \
  --parameter-overrides "Stage=${STAGE}" "BedrockRegion=${REGION}" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3 \
  --no-fail-on-empty-changeset

# ── 4) 출력 ─────────────────────────────────────────────────────
echo
echo "[phase4 deploy] outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table
