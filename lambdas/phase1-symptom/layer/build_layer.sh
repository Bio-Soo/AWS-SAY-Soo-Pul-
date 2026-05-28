#!/bin/bash
# Phase 1 Layer 빌드 — psycopg2-binary 만 포함.
# (handler.py 가 hpo_official.json 은 cold start 시 S3 → /tmp 에 다운로드하므로
#  Layer 에 포함하지 않음 — 22MB 파일을 Layer 에 넣으면 cold start 마다 unpack
#  비용이 큼.)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHASE1_DIR="$(cd "$HERE/.." && pwd)"
DEPS_BUILD="$PHASE1_DIR/layer/deps-build"

echo "[phase1 layer] cleaning previous build dir"
rm -rf "$DEPS_BUILD"
mkdir -p "$DEPS_BUILD/python"

# ── psycopg2-binary (Aurora INSERT) ─────────────────────────────
# Lambda 런타임 boto3 사용. 의존성은 psycopg2-binary 하나.
echo "[phase1 layer] installing python deps → $DEPS_BUILD/python"
PIP_CMD="${PIP_CMD:-python3 -m pip}"
$PIP_CMD install \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.11 \
  --only-binary=:all: \
  --target "$DEPS_BUILD/python" \
  "psycopg2-binary==2.9.9"

# ── 정리 ────────────────────────────────────────────────────────
find "$DEPS_BUILD/python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DEPS_BUILD/python" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true

deps_size=$(du -sm "$DEPS_BUILD" | awk '{print $1}')
echo "[phase1 layer] size: ${deps_size}MB (psycopg2-binary, limit 250)"
if [[ "$deps_size" -gt 250 ]]; then
  echo "[phase1 layer] ERROR: layer exceeds 250MB"
  exit 1
fi
echo "[phase1 layer] build complete"
