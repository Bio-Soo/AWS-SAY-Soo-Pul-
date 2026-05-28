#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Phase 5 RAG Pipeline SAM 배포 스크립트
#
# 사전 조건:
#   - AWS CLI 설정 완료 (환경변수 또는 ~/.aws/credentials)
#   - SAM CLI 설치 (pip install aws-sam-cli)
#   - Docker 실행 중 (--use-container 빌드용)
#   - S3 버킷에 rag_llm_3.py 업로드 완료:
#       s3://say2-2team-bucket/RAG/rag_llm_3.py
#
# 사용법:
#   chmod +x deploy.sh
#   ./deploy.sh [dev|staging|prod]
#
# 예시:
#   ./deploy.sh           # dev 환경 배포
#   ./deploy.sh staging   # staging 환경 배포
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${1:-dev}"
STACK_NAME="phase5-rag-${STAGE}"
S3_BUCKET="say2-2team-bucket"
REGION="ap-northeast-2"
SAM_ARTIFACTS_BUCKET="${S3_BUCKET}"
SAM_ARTIFACTS_PREFIX="SAM/phase5/${STAGE}"

echo "============================================================"
echo " Phase 5 RAG Pipeline 배포"
echo " Stage     : ${STAGE}"
echo " Stack     : ${STACK_NAME}"
echo " Region    : ${REGION}"
echo " S3 Bucket : ${S3_BUCKET}"
echo "============================================================"

# -----------------------------------------------------------------------------
# Step 1: S3에서 최신 rag_llm_3.py 다운로드
# -----------------------------------------------------------------------------
echo ""
echo "----- [Step 1/5] S3에서 rag_llm_3.py 다운로드 -----"
aws s3 cp \
    "s3://${S3_BUCKET}/RAG/rag_llm_3.py" \
    "${HERE}/lambda/rag_llm_3.py" \
    --region "${REGION}"

echo "rag_llm_3.py 다운로드 완료: ${HERE}/lambda/rag_llm_3.py"

# -----------------------------------------------------------------------------
# Step 2: Lambda Layer 빌드 (manylinux2014 binary)
# -----------------------------------------------------------------------------
echo ""
echo "----- [Step 2/5] Lambda Layer 빌드 -----"
chmod +x "${HERE}/layer/build_layer.sh"
"${HERE}/layer/build_layer.sh"

# -----------------------------------------------------------------------------
# Step 3: SAM 빌드
# -----------------------------------------------------------------------------
echo ""
echo "----- [Step 3/5] SAM 빌드 -----"
# handler.py + rag_llm_3.py는 순수 Python — Docker 컨테이너 불필요
# Layer deps는 build_layer.sh에서 manylinux2014 바이너리로 이미 빌드됨
sam build \
    --template-file "${HERE}/template.yaml" \
    --build-dir "${HERE}/.aws-sam/build"

# -----------------------------------------------------------------------------
# Step 4: SAM 배포
# -----------------------------------------------------------------------------
echo ""
echo "----- [Step 4/5] SAM 배포 -----"
sam deploy \
    --template-file "${HERE}/.aws-sam/build/template.yaml" \
    --stack-name "${STACK_NAME}" \
    --s3-bucket "${SAM_ARTIFACTS_BUCKET}" \
    --s3-prefix "${SAM_ARTIFACTS_PREFIX}" \
    --region "${REGION}" \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
    --parameter-overrides "Stage=${STAGE}" \
    --tags "project=pre-lambda-2-2-team" \
    --no-fail-on-empty-changeset

# -----------------------------------------------------------------------------
# Step 5: 배포 완료 — CloudFormation Outputs 출력
# -----------------------------------------------------------------------------
echo ""
echo "----- [Step 5/5] 배포 완료 — Stack Outputs -----"
aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}" \
    --output table

echo ""
echo "============================================================"
echo " 배포 성공: ${STACK_NAME}"
echo " 스테이지  : ${STAGE}"
echo "============================================================"

# 사용 예시 출력
API_URL=$(
    aws cloudformation describe-stacks \
        --stack-name "${STACK_NAME}" \
        --region "${REGION}" \
        --query "Stacks[0].Outputs[?OutputKey=='RunUrl'].OutputValue" \
        --output text 2>/dev/null || echo "(조회 실패)"
)

echo ""
echo "테스트 명령어:"
echo "  curl -X POST '${API_URL}' \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"session_id\": \"00000000-0000-0000-0000-000000000001\"}'"
echo ""
echo "헬스 체크:"
HEALTH_URL="${API_URL/\/run/\/health}"
echo "  curl '${HEALTH_URL}'"
