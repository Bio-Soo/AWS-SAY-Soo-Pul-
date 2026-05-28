#!/usr/bin/env bash
# Build + deploy frontend to S3 + CloudFront invalidate.
set -euo pipefail
[ -f .env ] || { echo "Need .env"; exit 1; }
source .env

cd "$(dirname "$0")/../frontend"

# Generate .env.production from .env so Vite picks up Cognito Pool ID etc.
cat > .env.production <<EOF
VITE_AWS_REGION=$AWS_REGION
VITE_COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID
VITE_COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID
VITE_COGNITO_DOMAIN=$COGNITO_DOMAIN
EOF

echo "[1/3] npm install..."
npm install --silent

echo "[2/3] npm run build..."
npm run build

echo "[3/3] s3 sync (SSE-AES256 — CRITICAL for CloudFront OAC compatibility)..."
aws s3 sync dist/ "s3://$S3_BUCKET/frontend/" --delete --sse AES256

echo "    CloudFront invalidation..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*" \
  --query 'Invalidation.[Id,Status]' --output text

echo ""
echo "✓ Frontend deployed: https://$CLOUDFRONT_DOMAIN/"
