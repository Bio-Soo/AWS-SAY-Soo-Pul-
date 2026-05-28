#!/usr/bin/env bash
# =============================================================================
# build_layer.sh — Phase 5 deps Layer 빌드
#
# pip install --platform manylinux2014_x86_64 (Lambda Amazon Linux 2 호환)
# 결과물: layer/deps-build/python/ → SAM이 ZIP으로 패키징
#
# 사용법:
#   chmod +x layer/build_layer.sh
#   ./layer/build_layer.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HERE}/deps-build/python"
MAX_SIZE_MB=240  # Lambda Layer 250MB 한도 — 여유 10MB 확보

echo "===== Phase 5 deps Layer 빌드 시작 ====="
echo "대상 디렉토리: ${DEST_DIR}"

# 이전 빌드 정리
if [ -d "${DEST_DIR}" ]; then
    echo "이전 빌드 정리 중..."
    rm -rf "${DEST_DIR}"
fi
mkdir -p "${DEST_DIR}"

# -----------------------------------------------------------------------------
# 공통 pip install 옵션 (manylinux2014 x86_64, Python 3.11, binary only)
# -----------------------------------------------------------------------------
PIP_COMMON_ARGS=(
    "--platform" "manylinux2014_x86_64"
    "--implementation" "cp"
    "--python-version" "3.11"
    "--only-binary=:all:"
    "--upgrade"
    "-t" "${DEST_DIR}"
)

echo ""
echo "----- [1/4] aiohttp==3.9.5 설치 -----"
pip install "${PIP_COMMON_ARGS[@]}" "aiohttp==3.9.5"

echo ""
echo "----- [2/4] psycopg2-binary==2.9.9 설치 -----"
pip install "${PIP_COMMON_ARGS[@]}" "psycopg2-binary==2.9.9"

echo ""
echo "----- [3/4] pandas>=2.0,<3.0 설치 -----"
pip install "${PIP_COMMON_ARGS[@]}" "pandas>=2.0,<3.0"

echo ""
echo "----- [4/4] requests>=2.31.0,<3.0 설치 -----"
pip install "${PIP_COMMON_ARGS[@]}" "requests>=2.31.0,<3.0"

# -----------------------------------------------------------------------------
# 250MB 한도 체크
# -----------------------------------------------------------------------------
echo ""
echo "----- 레이어 크기 확인 -----"
ACTUAL_MB=$(du -sm "${DEST_DIR}" | cut -f1)
echo "현재 크기: ${ACTUAL_MB} MB / 허용 한도: ${MAX_SIZE_MB} MB"

if [ "${ACTUAL_MB}" -gt "${MAX_SIZE_MB}" ]; then
    echo "[ERROR] 레이어 크기(${ACTUAL_MB}MB)가 한도(${MAX_SIZE_MB}MB)를 초과합니다."
    echo "        불필요한 패키지 제거 또는 버전 다운그레이드를 검토하세요."
    exit 1
fi

echo ""
echo "===== Phase 5 deps Layer 빌드 완료 ====="
echo "결과물 경로: ${DEST_DIR}"
echo "설치된 패키지:"
ls "${DEST_DIR}" | head -30
