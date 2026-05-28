#!/bin/bash
# Phase 1 로컬 invoke 테스트.
# 사전: ./layer/build_layer.sh 1회 실행 + AWS_PROFILE 설정 (Bedrock + S3 + Aurora 접근)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

sam local invoke Phase1SymptomFunction \
  --event events/sample_event.json \
  --parameter-overrides "Stage=dev" "BedrockRegion=ap-northeast-2"
