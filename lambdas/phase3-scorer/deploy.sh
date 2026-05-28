#!/bin/bash
# Phase 3 SAM 배포 스크립트
# Usage: ./deploy.sh [dev|staging|prod]   (default: dev)

set -euo pipefail

STAGE="${1:-dev}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "[phase3 deploy] stage=$STAGE"

# ── 1) Layer 빌드 ───────────────────────────────────────────────
./layer/build_layer.sh

# ── 2) SAM build ────────────────────────────────────────────────
echo "[phase3 deploy] sam build"
sam build --use-container

# ── 3) SAM deploy ───────────────────────────────────────────────
STACK_NAME="phase3-scorer-${STAGE}"
echo "[phase3 deploy] sam deploy stack=$STACK_NAME"
sam deploy \
  --stack-name "$STACK_NAME" \
  --parameter-overrides "Stage=${STAGE}" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3 \
  --no-fail-on-empty-changeset

# ── 4) 출력 ─────────────────────────────────────────────────────
echo
echo "[phase3 deploy] outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table
