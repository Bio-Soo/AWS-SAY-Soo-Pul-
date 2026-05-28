#!/bin/bash
# Phase 3 Layer 빌드 — 두 개의 layer 디렉토리를 생성.
#   layer/data-build/data/         : YAML + Excel registry files
#   layer/deps-build/python/       : lung_dx package + Python deps
#
# SAM은 ContentUri 디렉토리를 zip으로 패키징해서 Lambda Layer로 게시한다.
# AWS Lambda는 layer를 /opt 에 마운트 → /opt/data, /opt/python.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root = rare-link-ai-frontend (s3_clone/Phase_3/infra/aws/phase3/layer 의 5단계 위)
PROJECT_ROOT="$(cd "$HERE/../../../../../.." && pwd)"
# lung_dx 패키지는 s3_clone/lung_dx 에 있다 (2026-05-19 v3_6 swap 후)
LUNG_DX_SRC="$PROJECT_ROOT/s3_clone/lung_dx"
PHASE3_DIR="$(cd "$HERE/.." && pwd)"

DATA_BUILD="$PHASE3_DIR/layer/data-build"
DEPS_BUILD="$PHASE3_DIR/layer/deps-build"

echo "[phase3 layer] cleaning previous build dirs"
rm -rf "$DATA_BUILD" "$DEPS_BUILD"
mkdir -p "$DATA_BUILD/data" "$DEPS_BUILD/python"

# ── 1) data layer ──────────────────────────────────────────────
echo "[phase3 layer] copying registry data files → $DATA_BUILD/data"
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
    cp "$PROJECT_ROOT/data/$f" "$DATA_BUILD/data/"
    echo "  + $f"
  else
    echo "  ! WARNING: $f not found in $PROJECT_ROOT/data/"
  fi
done

# ── 2) deps layer (lung_dx + 의존 패키지) ───────────────────────
echo "[phase3 layer] installing python deps → $DEPS_BUILD/python"
# 의존성 6개 — lung_dx 코드 전수 grep 검증 결과 (2026-05-07):
#   PyYAML            ← knowledge/disease_registry.py · lab_reference.py / phase4 guard_rails.py
#   openpyxl          ← knowledge/excel_loader.py (Excel sheet 직접 조작)
#   pandas            ← knowledge/excel_loader.py: pd.read_excel() 4 sheet
#   pydantic          ← config/settings.py: Field
#   pydantic-settings ← config/settings.py: BaseSettings (config/__init__.py가 강제 로드)
#   psycopg2-binary   ← handler.py phase_execution_log INSERT, diagnosis_session UPDATE (Aurora)
PIP_CMD="${PIP_CMD:-python3 -m pip}"
$PIP_CMD install \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.11 \
  --only-binary=:all: \
  --target "$DEPS_BUILD/python" \
  PyYAML==6.0.2 \
  openpyxl==3.1.5 \
  "pandas>=2.0,<3.0" \
  "pydantic>=2.0,<3.0" \
  "pydantic-settings>=2.0,<3.0" \
  "psycopg2-binary==2.9.9"

echo "[phase3 layer] copying lung_dx package → $DEPS_BUILD/python/lung_dx (from $LUNG_DX_SRC)"
cp -r "$LUNG_DX_SRC" "$DEPS_BUILD/python/lung_dx"

# lung_dx paths.py 의 hardcoded DATA_DIR=/opt/python/data 에 yaml/xlsx 복사
# (data Layer 의 /opt/data 와 별개 — lung_dx 는 paths.py 의 default 사용)
echo "[phase3 layer] copying data files also into $DEPS_BUILD/python/data"
mkdir -p "$DEPS_BUILD/python/data"
for f in "${DATA_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/data/$f" ]]; then
    cp "$PROJECT_ROOT/data/$f" "$DEPS_BUILD/python/data/"
  fi
done

# Lambda Layer는 /opt/python에 마운트 — sys.path 자동 포함.
# 불필요 항목 정리 (테스트, 캐시).
find "$DEPS_BUILD/python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DEPS_BUILD/python" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true

# ── 크기 확인 (250MB 한도) ──────────────────────────────────────
data_size=$(du -sm "$DATA_BUILD" | awk '{print $1}')
deps_size=$(du -sm "$DEPS_BUILD" | awk '{print $1}')
echo
echo "[phase3 layer] sizes:"
echo "  data: ${data_size} MB  (limit 250)"
echo "  deps: ${deps_size} MB  (limit 250)"
if [[ "$deps_size" -gt 250 || "$data_size" -gt 250 ]]; then
  echo "[phase3 layer] ERROR: layer exceeds 250MB Lambda limit"
  exit 1
fi
echo "[phase3 layer] build complete"
