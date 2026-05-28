#!/usr/bin/env bash
# Deploy Step Functions state machine + IAM role.
set -euo pipefail
[ -f .env ] || { echo "Need .env"; exit 1; }
source .env

cd "$(dirname "$0")/.."

ACCOUNT=$AWS_ACCOUNT_ID
REGION=$AWS_REGION
SFN_NAME=${STEPFN_NAME:-soonet-pulmonary-pipeline}
ROLE_NAME=${STEPFN_ROLE_NAME:-soonet-pulmonary-stepfn-role}

# ── 1. Create role if not exists ──
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating SFN role $ROLE_NAME..."
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"states.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' --tags Key=project,Value=soonet-pulmonary
fi

# ── 2. Inline policy (Lambda invoke + Logs + X-Ray) ──
cat > /tmp/sfn-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokePhaseLambdas",
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": [
        "arn:aws:lambda:$REGION:$ACCOUNT:function:phase1-symptom-dev*",
        "arn:aws:lambda:$REGION:$ACCOUNT:function:say2-2team-phase2-vision*",
        "arn:aws:lambda:$REGION:$ACCOUNT:function:phase3-scorer-dev*",
        "arn:aws:lambda:$REGION:$ACCOUNT:function:phase4-verifier-dev*",
        "arn:aws:lambda:$REGION:$ACCOUNT:function:phase5-lr-dev*",
        "arn:aws:lambda:$REGION:$ACCOUNT:function:report-rag-dev*"
      ]
    },
    {
      "Sid": "CloudWatchLogsForStepFunctions",
      "Effect": "Allow",
      "Action": ["logs:CreateLogDelivery","logs:GetLogDelivery","logs:UpdateLogDelivery","logs:DeleteLogDelivery","logs:ListLogDeliveries","logs:PutResourcePolicy","logs:DescribeResourcePolicies","logs:DescribeLogGroups"],
      "Resource": "*"
    },
    {
      "Sid": "XRayTracing",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments","xray:PutTelemetryRecords","xray:GetSamplingRules","xray:GetSamplingTargets"],
      "Resource": "*"
    }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "${SFN_NAME}-policy" --policy-document file:///tmp/sfn-policy.json

# ── 3. Substitute account/region in ASL + create/update state machine ──
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE_NAME"
sed -e "s|\$ACCOUNT|$ACCOUNT|g" -e "s|\$REGION|$REGION|g" \
    stepfunctions/pipeline.asl.json > /tmp/sfn-def.json

SFN_ARN="arn:aws:states:$REGION:$ACCOUNT:stateMachine:$SFN_NAME"

if aws stepfunctions describe-state-machine --state-machine-arn "$SFN_ARN" >/dev/null 2>&1; then
  echo "Updating existing SFN $SFN_ARN"
  aws stepfunctions update-state-machine \
    --state-machine-arn "$SFN_ARN" \
    --definition file:///tmp/sfn-def.json \
    --role-arn "$ROLE_ARN"
else
  echo "Creating SFN $SFN_NAME"
  aws stepfunctions create-state-machine \
    --name "$SFN_NAME" \
    --definition file:///tmp/sfn-def.json \
    --role-arn "$ROLE_ARN" \
    --type STANDARD \
    --tags key=project,value=soonet-pulmonary
fi

echo "✓ SFN deployed: $SFN_ARN"
