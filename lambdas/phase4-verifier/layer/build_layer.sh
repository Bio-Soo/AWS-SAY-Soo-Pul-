#!/bin/bash
# Phase 4 Layer 빌드 — lung_dx phase4 verifier + 의존성.
# Lambda는 boto3를 런타임 자체에 포함 → layer에는 lung_dx만.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/../../../../../.." && pwd)"
LUNG_DX_SRC="$PROJECT_ROOT/s3_clone/lung_dx"
PHASE4_DIR="$(cd "$HERE/.." && pwd)"
DEPS_BUILD="$PHASE4_DIR/layer/deps-build"

echo "[phase4 layer] cleaning previous build dir"
rm -rf "$DEPS_BUILD"
mkdir -p "$DEPS_BUILD/python/data"

# ── 1) data — lung_dx 가 /opt/python/data/ 에서 yaml 찾음 (default path) ──
# (별도 DataLayer 안 만듦 — SAM 의 비표준 Layer 구조 회피)
echo "[phase4 layer] copying registry data files → $DEPS_BUILD/python/data"
DATA_FILES=(
  "lung_disease_profiles_v3_6.yaml"
  "lab_reference_ranges_v9_5.yaml"
  "chexpert_label_reference_v1.yaml"
  "icd10_reference_v1.json"
  "korean_hpo_dictionary_v1.json"
  "multilingual_phenotype_lexicon_v1.json"
  "일반_폐질환_데이터베이스_v9.xlsx"
  "기타_폐관련_질환_데이터베이스_v9.xlsx"
  "희귀_폐질환_데이터베이스_v5.xlsx"
)
for f in "${DATA_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/data/$f" ]]; then
    cp "$PROJECT_ROOT/data/$f" "$DEPS_BUILD/python/data/"
    echo "  + $f"
  else
    echo "  ! WARNING: $f not found in $PROJECT_ROOT/data/"
  fi
done

# ── 2) lung_dx 코드 ────────────────────────────────────────────
echo "[phase4 layer] copying lung_dx package → $DEPS_BUILD/python/lung_dx (from $LUNG_DX_SRC)"
cp -r "$LUNG_DX_SRC" "$DEPS_BUILD/python/lung_dx"

# ── 추가 deps (phase4가 의존하는 외부 패키지) ──────────────────
# 의존성 4개 — lung_dx 코드 전수 grep 검증 결과 (2026-05-07):
#   PyYAML            ← phase4_llm_verify/guard_rails.py: import yaml
#   pydantic          ← config/settings.py: Field (phase4가 ..config import paths 호출)
#   pydantic-settings ← config/settings.py: BaseSettings (config/__init__.py 강제 로드)
#   psycopg2-binary   ← handler.py phase_execution_log INSERT, diagnosis_session UPDATE (Aurora)
# 주의: phase4는 boto3·botocore를 Lambda 런타임에서 받아오므로 layer 미포함.
echo "[phase4 layer] installing python deps → $DEPS_BUILD/python"
PIP_CMD="${PIP_CMD:-python3 -m pip}"
$PIP_CMD install \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.11 \
  --only-binary=:all: \
  --target "$DEPS_BUILD/python" \
  PyYAML==6.0.2 \
  "pydantic>=2.0,<3.0" \
  "pydantic-settings>=2.0,<3.0" \
  "psycopg2-binary==2.9.9"

# ── 정리 ────────────────────────────────────────────────────────
find "$DEPS_BUILD/python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DEPS_BUILD/python" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true

deps_size=$(du -sm "$DEPS_BUILD" | awk '{print $1}')
echo "[phase4 layer] size: ${deps_size}MB (data + deps + lung_dx, limit 250)"
if [[ "$deps_size" -gt 250 ]]; then
  echo "[phase4 layer] ERROR: layer exceeds 250MB"
  exit 1
fi
echo "[phase4 layer] build complete"
