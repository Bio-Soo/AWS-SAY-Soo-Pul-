#!/bin/bash
# Phase 1 SAM 배포 — symptom → HPO 추출 Lambda.
# Usage: ./deploy.sh [dev|staging|prod] [bedrock-region]
#   default: dev ap-northeast-2
#
# 사전 조건:
#   1. Phase_1/hpo_official.json 이 S3 (say2-2team-bucket) 에 업로드돼 있음
#   2. AWS Bedrock 콘솔에서 Anthropic Claude 3.5 Sonnet 모델 액세스 활성화
#   3. 아래 VPC/Security Group/Subnet ID 가 다른 phase Lambda 와 동일한지 확인:
#        - sg-08d35c498d8886a98       (say2-2team-sg-lambda)
#        - subnet-02eed659772bac6aa   (private-a)
#        - subnet-08f8d0eaa597b4f04   (private-b)
#      변경되었으면 template.yaml 의 VpcConfig 수정.

set -euo pipefail

STAGE="${1:-dev}"
REGION="${2:-ap-northeast-2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "[phase1 deploy] stage=$STAGE bedrock_region=$REGION"

# ── 사전 점검: hpo_official.json S3 객체 ────────────────────────
echo "[phase1 deploy] checking S3 object Phase_1/hpo_official.json..."
if ! aws s3api head-object --bucket say2-2team-bucket --key Phase_1/hpo_official.json >/dev/null 2>&1; then
  echo "[phase1 deploy] ERROR: s3://say2-2team-bucket/Phase_1/hpo_official.json 가 없습니다."
  echo "  Phase_1/hpo_official.json 를 먼저 S3 에 업로드하세요."
  exit 1
fi

# ── 사전 점검: Bedrock 모델 액세스 ───────────────────────────────
echo "[phase1 deploy] checking Bedrock model access (Anthropic Claude 3.5 Sonnet)..."
if ! aws bedrock list-foundation-models --region "$REGION" \
      --query "modelSummaries[?contains(modelId, 'claude-3-5-sonnet')].modelId" \
      --output text 2>/dev/null | grep -q claude-3-5-sonnet; then
  echo "[phase1 deploy] WARN: Bedrock 모델 액세스 확인 실패."
  echo "  AWS 콘솔 → Bedrock → Model access 에서 Anthropic Claude 3.5 Sonnet 활성화 필요."
fi

# ── 1) Layer 빌드 ───────────────────────────────────────────────
./layer/build_layer.sh

# ── 2) SAM build ────────────────────────────────────────────────
echo "[phase1 deploy] sam build"
sam build --use-container

# ── 3) SAM deploy ───────────────────────────────────────────────
STACK_NAME="phase1-symptom-${STAGE}"
echo "[phase1 deploy] sam deploy stack=$STACK_NAME"
sam deploy \
  --stack-name "$STACK_NAME" \
  --parameter-overrides "Stage=${STAGE}" "BedrockRegion=${REGION}" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3 \
  --no-fail-on-empty-changeset

# ── 4) 출력 ─────────────────────────────────────────────────────
echo
echo "[phase1 deploy] outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table
