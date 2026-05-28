#!/usr/bin/env bash
# Deploy FastAPI backend to EC2 via SSM RunCommand (no SSH required).
# Assumes EC2 already has Python 3.12 + uvicorn installed (handled by bootstrap-infra.sh).
set -euo pipefail
[ -f .env ] || { echo "Need .env"; exit 1; }
source .env

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# ── 1. Package backend code ──
echo "[1/4] Packaging backend..."
PKG=/tmp/soonet-backend.tar.gz
tar -czf "$PKG" -C "$ROOT/backend" api/

# ── 2. Upload to S3 ──
echo "[2/4] Upload to s3://$S3_BUCKET/deploy/backend/..."
aws s3 cp "$PKG" "s3://$S3_BUCKET/deploy/backend/soonet-backend.tar.gz" --sse AES256

# ── 3. Write db.env from .env ──
DB_PASSWORD_PLACEHOLDER='${DB_PASSWORD}'   # resolved on EC2 from Secrets Manager
cat > /tmp/db.env <<EOF
DATABASE_URL=postgresql+asyncpg://${AURORA_DB_USER}:${DB_PASSWORD_PLACEHOLDER}@${AURORA_CLUSTER_ENDPOINT}:5432/${AURORA_DB_NAME}?ssl=require
STEPFN_STATE_MACHINE_ARN=arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT_ID}:stateMachine:${STEPFN_NAME:-soonet-pulmonary-pipeline}
DEV_BYPASS_AUTH=${DEV_BYPASS_AUTH:-0}
DEV_STEPFN_DUMMY=${DEV_STEPFN_DUMMY:-0}
POLL_MODE=${POLL_MODE:-mock}
CRON_PRELOAD_TOKEN=${CRON_PRELOAD_TOKEN}
EOF
aws s3 cp /tmp/db.env "s3://$S3_BUCKET/deploy/backend/db.env" --sse AES256

# ── 4. SSM RunCommand on EC2 ──
echo "[3/4] Triggering deploy on EC2 ($EC2_INSTANCE_ID)..."
CMD=$(cat <<'EOSSM'
set -e
mkdir -p /srv/soonet-pulmonary
aws s3 cp s3://__BUCKET__/deploy/backend/soonet-backend.tar.gz /tmp/ --quiet
tar -xzf /tmp/soonet-backend.tar.gz -C /srv/soonet-pulmonary/
mkdir -p /etc/soonet-api
aws s3 cp s3://__BUCKET__/deploy/backend/db.env /etc/soonet-api/db.env --quiet
# Resolve actual DB password from Secrets Manager
PWD=$(aws secretsmanager get-secret-value --secret-id __SECRET__ --query SecretString --output text | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('password', d if isinstance(d,str) else ''))")
sed -i "s|\${DB_PASSWORD}|$PWD|g" /etc/soonet-api/db.env
chmod 600 /etc/soonet-api/db.env
systemctl daemon-reload
systemctl restart soonet-api.service
sleep 4
systemctl is-active soonet-api.service
curl -sS http://localhost:8000/health
EOSSM
)
CMD="${CMD//__BUCKET__/$S3_BUCKET}"
CMD="${CMD//__SECRET__/$SECRET_AURORA_APP_USER}"
B64=$(echo "$CMD" | base64 -w0)

CID=$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --instance-ids "$EC2_INSTANCE_ID" \
  --parameters "commands=echo $B64 | base64 -d | bash" \
  --query 'Command.CommandId' --output text)
echo "    SSM CommandID: $CID"

echo "[4/4] Waiting up to 90s..."
for i in {1..30}; do
  S=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$EC2_INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo "Pending")
  [ "$S" != "InProgress" ] && [ "$S" != "Pending" ] && break
  sleep 3
done

aws ssm get-command-invocation --command-id "$CID" --instance-id "$EC2_INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

echo ""
echo "✓ Backend deployed. Health: https://$CLOUDFRONT_DOMAIN/health"
