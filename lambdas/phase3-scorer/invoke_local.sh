#!/bin/bash
# Phase 3 로컬 invoke — sam local invoke로 실제 Lambda 환경에 가깝게 실행.
# 전제: layer 빌드 완료 (./layer/build_layer.sh)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# layer 빌드 누락 시 자동 빌드
if [[ ! -d layer/data-build || ! -d layer/deps-build ]]; then
  echo "[invoke_local] layer build missing — rebuilding"
  ./layer/build_layer.sh
fi

echo "[invoke_local] sam build"
sam build --use-container

echo "[invoke_local] sam local invoke Phase3ScorerFunction"
sam local invoke Phase3ScorerFunction \
  --event events/sample_event.json \
  --parameter-overrides "Stage=dev"
