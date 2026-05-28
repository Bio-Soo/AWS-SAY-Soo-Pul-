#!/bin/bash
# Phase 5 LR Layer build
#   layer/data-build/data/     : hpo_background_freq.json + rare_disease_profiles_v3_1.yaml
#   layer/deps-build/python/   : psycopg2-binary + PyYAML
#
# Lambda 는 layer 를 /opt 에 마운트 → /opt/data, /opt/python
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LR_DIR="$(cd "$HERE/.." && pwd)"
PHASE5_ROOT="$(cd "$HERE/../../../.." && pwd)"

DATA_BUILD="$LR_DIR/layer/data-build"
DEPS_BUILD="$LR_DIR/layer/deps-build"

echo "[phase5-lr layer] cleaning"
rm -rf "$DATA_BUILD" "$DEPS_BUILD"
mkdir -p "$DATA_BUILD/data" "$DEPS_BUILD/python"

# ── 1) data layer ────────────────────────────────────────────────
echo "[phase5-lr layer] copying KB data"
BG_SRC="$PHASE5_ROOT/lr_data/hpo_background_freq.json"
YAML_SRC="$PHASE5_ROOT/rare_disease_profiles_v3_1.yaml"

if [[ ! -f "$BG_SRC" ]]; then
  echo "  ! ERROR: $BG_SRC not found (run deploy.sh which downloads from S3)"
  exit 1
fi
if [[ ! -f "$YAML_SRC" ]]; then
  echo "  ! ERROR: $YAML_SRC not found (run deploy.sh which downloads from S3)"
  exit 1
fi
cp "$BG_SRC" "$DATA_BUILD/data/"
cp "$YAML_SRC" "$DATA_BUILD/data/"
echo "  + hpo_background_freq.json"
echo "  + rare_disease_profiles_v3_1.yaml"

# ── 2) deps layer ────────────────────────────────────────────────
echo "[phase5-lr layer] installing python deps"
PIP_CMD="${PIP_CMD:-python3 -m pip}"
$PIP_CMD install \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.11 \
  --only-binary=:all: \
  --target "$DEPS_BUILD/python" \
  "psycopg2-binary==2.9.9" \
  "PyYAML==6.0.2"

# cleanup
find "$DEPS_BUILD/python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DEPS_BUILD/python" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true

data_size=$(du -sm "$DATA_BUILD" | awk '{print $1}')
deps_size=$(du -sm "$DEPS_BUILD" | awk '{print $1}')
echo
echo "[phase5-lr layer] sizes:"
echo "  data: ${data_size} MB  (limit 250)"
echo "  deps: ${deps_size} MB  (limit 250)"
if [[ "$deps_size" -gt 250 || "$data_size" -gt 250 ]]; then
  echo "[phase5-lr layer] ERROR: layer exceeds 250MB Lambda limit"
  exit 1
fi
echo "[phase5-lr layer] build complete"
