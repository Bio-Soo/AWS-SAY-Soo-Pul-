#!/usr/bin/env bash
# One-time find/replace to substitute the original team's identifiers
# with values from your .env. Run once after cloning.
#
# This rewrites source files in-place (commit before running if you want diffs).
set -euo pipefail
[ -f .env ] || { echo "Need .env (copy from .env.example)"; exit 1; }
source .env

cd "$(dirname "$0")/.."

# Pairs: old → new
declare -a PAIRS=(
  "666803869796|${AWS_ACCOUNT_ID}"
  "patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com|${AURORA_CLUSTER_ENDPOINT}"
  "say2-2team-bucket|${S3_BUCKET}"
  "say2-2team-rare-link-pipeline|${STEPFN_NAME:-soonet-pulmonary-pipeline}"
  "say2-2team-rare-link-stepfn-role|${STEPFN_ROLE_NAME:-soonet-pulmonary-stepfn-role}"
  "say2-2team-rare-link-pool|${COGNITO_USER_POOL_NAME:-soonet-pulmonary-pool}"
  "vpc-06dd0ad1f2335ea74|${VPC_ID}"
  "ap-northeast-2_CMtZTRCTa|${COGNITO_USER_POOL_ID}"
  "d300v14l8u0wx7.cloudfront.net|${CLOUDFRONT_DOMAIN}"
  "E2ZHONIV05TX9D|${CLOUDFRONT_DISTRIBUTION_ID}"
  "say2-2team-soonet-endpoint|${SAGEMAKER_ENDPOINT:-soonet-endpoint}"
  "i-0f3f223fd40217b12|${EC2_INSTANCE_ID:-i-PLACEHOLDER}"
)

# File globs to skip
EXCLUDE_GLOBS=(
  "node_modules" ".git" "dist" "build" ".aws-sam"
  "__pycache__" ".pytest_cache" "package-lock.json"
  ".env" ".env.local"
)
EXCLUDE_ARGS=""
for g in "${EXCLUDE_GLOBS[@]}"; do
  EXCLUDE_ARGS="$EXCLUDE_ARGS --exclude-dir=$g"
done

# Use ripgrep if available (faster), else fall back to grep
if command -v rg >/dev/null 2>&1; then
  FILES=$(rg -l -uu --no-ignore-vcs \
    -g '!node_modules' -g '!dist' -g '!build' -g '!.aws-sam' \
    -g '!__pycache__' -g '!.git' -g '!package-lock.json' \
    -g '!.env*' \
    "$(IFS='|'; echo "${PAIRS[0]%%|*}|${PAIRS[1]%%|*}|${PAIRS[2]%%|*}")" \
    . 2>/dev/null | sort -u || true)
else
  FILES=$(grep -rlI $EXCLUDE_ARGS -E "$(IFS='|'; echo "${PAIRS[*]%%|*}" | tr ' ' '|')" . 2>/dev/null || true)
fi

if [ -z "$FILES" ]; then
  echo "No files contain known identifiers — nothing to do (or already applied)."
  exit 0
fi

echo "Files to rewrite:"
echo "$FILES" | head -20
[ $(echo "$FILES" | wc -l) -gt 20 ] && echo "...(and $(($(echo "$FILES" | wc -l) - 20)) more)"

read -p "Proceed with in-place rewrite? [y/N] " ans
[ "$ans" = "y" ] || { echo "Aborted."; exit 0; }

for pair in "${PAIRS[@]}"; do
  OLD="${pair%%|*}"
  NEW="${pair##*|}"
  if [ -z "$NEW" ] || [ "$NEW" = "$OLD" ]; then
    echo "  skip: $OLD (no value in .env)"
    continue
  fi
  echo "  $OLD → $NEW"
  echo "$FILES" | xargs -I {} sed -i.bak "s|$OLD|$NEW|g" {} 2>/dev/null || true
  echo "$FILES" | xargs -I {} rm -f {}.bak 2>/dev/null || true
done

echo ""
echo "✓ Done. Verify with:"
echo "   grep -r 'patient-db-cluster.cluster-cxmiyawwwhbt' . --include='*.py' --include='*.json'"
echo "   (should return nothing)"
