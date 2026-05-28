#!/usr/bin/env bash
# Phase 5 LR — SAM deploy
#
# 사용법 (EC2 i-0f3f223fd40217b12 — VPC 06dd0... 안):
#   chmod +x deploy.sh
#   ./deploy.sh [dev|staging|prod]
#
# 사전 조건:
#   - sam CLI 설치 (/usr/local/bin/sam)
#   - docker 실행 중 (--use-container 빌드)
#   - aws CLI 자격증명 (CloudFormation/Lambda/APIGW/IAM 권한)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${1:-dev}"
STACK_NAME="phase5-lr-${STAGE}"
S3_BUCKET="say2-2team-bucket"
REGION="ap-northeast-2"
PHASE5_ROOT="$(cd "$HERE/../../.." && pwd)"

cd "$HERE"

echo "============================================================"
echo " Phase 5 LR — SAM 배포"
echo " Stage     : ${STAGE}"
echo " Stack     : ${STACK_NAME}"
echo " Region    : ${REGION}"
echo " HERE      : ${HERE}"
echo " PHASE5    : ${PHASE5_ROOT}"
echo "============================================================"

# ── Step 1: KB 데이터 S3 → 로컬 ─────────────────────────────────
echo "[1] KB 데이터 다운로드 (S3 → ${PHASE5_ROOT})"
mkdir -p "$PHASE5_ROOT/lr_data"
aws s3 cp "s3://${S3_BUCKET}/Phase_5/lr_data/hpo_background_freq.json" \
  "$PHASE5_ROOT/lr_data/" --region "$REGION" --quiet
aws s3 cp "s3://${S3_BUCKET}/Phase_5/rare_disease_profiles_v3_1.yaml" \
  "$PHASE5_ROOT/" --region "$REGION" --quiet
echo "  OK"

# ── Step 2: Layer 빌드 ──────────────────────────────────────────
echo "[2] Layer 빌드"
chmod +x ./layer/build_layer.sh
./layer/build_layer.sh

# ── Step 3: sam build ───────────────────────────────────────────
echo "[3] sam build --use-container"
sam build --use-container

# ── Step 4: sam deploy ──────────────────────────────────────────
echo "[4] sam deploy → stack=${STACK_NAME}"
sam deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --parameter-overrides "Stage=${STAGE}" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3 \
  --no-fail-on-empty-changeset \
  --tags project=pre-2-2team

# ── Step 5: 출력 ────────────────────────────────────────────────
echo
echo "[5] Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output table

echo
echo "[Done] Phase 5 LR 배포 완료."
echo "테스트: aws lambda invoke --function-name phase5-lr-${STAGE} \\"
echo "  --payload '{\"session_id\":\"<UUID>\"}' --cli-binary-format raw-in-base64-out /tmp/out.json"
