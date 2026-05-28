#!/bin/bash
# Phase 4 로컬 invoke.
# Bedrock 호출 없이 검증하려면 events/sample_event.json의 mode를 "mock"으로.
# 실제 Bedrock 호출 검증은 mode="real" + AWS 인증 + 모델 액세스 필요.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ ! -d layer/deps-build ]]; then
  echo "[invoke_local] layer build missing — rebuilding"
  ./layer/build_layer.sh
fi

echo "[invoke_local] sam build"
sam build --use-container

echo "[invoke_local] sam local invoke Phase4VerifierFunction"
sam local invoke Phase4VerifierFunction \
  --event events/sample_event.json \
  --parameter-overrides "Stage=dev" "BedrockRegion=us-east-1"
