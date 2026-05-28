# Runbook — Operations + Troubleshooting

Common failure modes encountered during development + their fixes.

## "Frontend shows infinite loading / blank workspace"

**Symptom:** Doctor opens https://your-cf.cloudfront.net/, sees loading spinner forever.

**Likely causes:**
1. **CloudFront cache** — old `index.html` referencing deleted JS bundles. Invalidate:
   ```bash
   aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/*"
   ```
2. **API can't reach DB** — FastAPI returns 500 on `/api/v1/sessions`. Check:
   ```bash
   curl https://your-cf/health
   sudo journalctl -u soonet-api.service -n 50
   ```
   Look for `asyncpg.exceptions.InvalidCatalogNameError: database "X" does not exist` → DATABASE_URL points to wrong DB name. Fix in `/etc/soonet-api/db.env` + `systemctl restart`.

3. **Mock worklist date filter** — `worklist.json` is hardcoded `date: 2026-04-23`. If frontend filters by today's date, it shows empty list. Either patch the frontend filter or regenerate worklist.json with today's date.

## "Phase X result not appearing in API response"

**Symptom:** `/sessions/{id}` returns `phase3: null` even after SFN completes.

**Diagnostic:**
```bash
# Check SFN execution events
aws stepfunctions get-execution-history --execution-arn $EXEC_ARN \
  --query 'events[?type==`TaskFailed` || type==`TaskSucceeded`]' --output table

# Check phase_execution_log table
psql -h $AURORA_HOST -U app_user -d soopul -c "
  SELECT phase_name, phase_step, status, error_code, error_message
  FROM soopulai.phase_execution_log
  WHERE session_id='$SID' ORDER BY started_at"
```

**Common findings:**
- `error_code=FILENOTFOUNDERROR` on phase3/4 → Lambda deps layer missing `lung_disease_profiles_v3_6.yaml`. Rebuild layer:
  ```bash
  cd lambdas/phase3-scorer && ./layer/build_layer.sh && sam deploy
  ```
- `error_code=VALIDATIONEXCEPTION` from Bedrock → model ID needs `apac.` prefix or inference profile
- `error_code=ACCESSDENIEDEXCEPTION` from Bedrock → IAM policy doesn't allow this model. Add to `infra/iam/phase4-bedrock-policy.json`

## "Lambda times out at 5 min (silent hang)"

**Symptom:** SFN shows `Lambda.AWSLambdaException: Task timed out after 300.00 seconds`. CloudWatch log shows only `Found credentials in environment variables.` and then nothing.

**Cause:** The Lambda's VPC subnet has no NAT egress, so `boto3.client('secretsmanager').get_secret_value()` hangs trying to reach the public Secrets Manager endpoint.

**Diagnostic:**
```bash
# Check which subnets the Lambda uses
aws lambda get-function-configuration --function-name $FN --query VpcConfig.SubnetIds

# For each subnet, check its route table
aws ec2 describe-route-tables \
  --filters "Name=association.subnet-id,Values=subnet-xxx" \
  --query 'RouteTables[*].Routes[*].[DestinationCidrBlock,NatGatewayId,GatewayId]'
```

A subnet without an `0.0.0.0/0 → nat-...` route is the culprit. Either:
- Add a NAT route to that subnet's RT, or
- Replace it in Lambda config with a NAT-routed subnet.

## "report-rag returns 'invalid model identifier'"

**Cause:** Lambda code was deployed before `BEDROCK_MODEL_ID` env var support was added. The class attribute `BEDROCK_MODEL_ID = "hardcoded-model"` overrides env at module load.

**Fix:** Pull latest `rag_llm_3.py` from source, repackage, redeploy:
```bash
cd lambdas/report-rag
zip -q /tmp/rag.zip lambda/handler.py lambda/rag_llm_3.py lambda/requirements.txt
aws lambda update-function-code --function-name report-rag-dev --zip-file fileb:///tmp/rag.zip
```

## "Phase 2 returns 400 'xray_s3_key required'"

**Cause:** Lambda fell back to `_read_latest_imaging_study(patient_id)` because `xray_s3_key=null`, but the imaging_study lookup failed (DB connection error OR no rows for this patient).

**Diagnostic:**
```bash
# Check imaging_study table for the patient
psql -c "SELECT COUNT(*) FROM soopulai.imaging_study WHERE patient_id='$PID'"

# Check Lambda's actual DB connection (look for "FATAL: database X does not exist")
aws logs tail /aws/lambda/say2-2team-phase2-vision --since 5m | grep -i "error\|fatal"
```

If `database X does not exist` — Lambda code has old DB_NAME. Redeploy from source. If `count=0` — seed imaging_study for the patient (see `database/seed/imaging_study.sql`).

## "Bedrock returns AccessDenied even though IAM policy looks right"

**Cause:** Inference profile invocation requires permission on BOTH the inference-profile ARN AND the underlying foundation-model ARNs across ALL regions the profile spans.

**Fix in IAM policy:**
```json
{
  "Action": ["bedrock:InvokeModel"],
  "Resource": [
    "arn:aws:bedrock:ap-northeast-2:ACCOUNT:inference-profile/apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0"
  ]
}
```
The `*` wildcard for foundation-model region matters — the profile may invoke the model in ap-northeast-1, ap-southeast-2, etc.

## "SFN cant invoke a Lambda after rename"

**Symptom:** SFN execution fails with `User is not authorized to perform: lambda:InvokeFunction on resource: arn:...:function:new-name`.

**Cause:** The SFN role's IAM policy still lists the OLD function name.

**Fix:** Add the new ARN to the SFN role policy:
```bash
# Edit infra/iam/stepfn-role-policy.json — add new function ARN, redeploy
./scripts/deploy-stepfunctions.sh
```

## "psql / asyncpg: PostgreSQL connection terminated by administrator"

**Cause:** Aurora is auto-scaling/pausing (serverless v2 with min_capacity=0). Connections drop during scale events.

**Mitigation:**
- Set min_capacity ≥ 0.5 ACU on the Aurora cluster (sometimes 0.0 causes pause-induced disconnects)
- Use asyncpg pool with `max_inactive_connection_lifetime=60`
- Add `connect_timeout=10, command_timeout=30` to connection args

## "Session marked failed but all phases populated"

**Cause:** RAG phase logged the error to `diagnosis_session.error_message` but couldn't generate the final report — usually a Bedrock model ID issue.

**Diagnostic:**
```sql
SELECT session_id, status, current_phase, error_message
FROM soopulai.diagnosis_session
ORDER BY initiated_at DESC LIMIT 5;
```

If `error_message` mentions "model identifier is invalid" — fix BEDROCK_MODEL_ID on report-rag-dev (see "invalid model identifier" section above).

## "CloudFront serves stale frontend after deploy"

**Cause:** You forgot the invalidation, OR you uploaded with `aws:kms` encryption (default S3 setting) instead of `AES256`.

**Check:**
```bash
# Should show ServerSideEncryption: AES256
aws s3api head-object --bucket $S3_BUCKET --key frontend/index.html --query ServerSideEncryption

# If aws:kms, re-upload:
aws s3 sync frontend/dist/ s3://$S3_BUCKET/frontend/ --delete --sse AES256
```

The CloudFront Origin Access Control doesn't have KMS decrypt permission, so KMS-encrypted objects return 403 AccessDenied.

## Emergency rollback

```bash
# Rollback a Lambda to previous version
PREV=$(aws lambda list-versions-by-function --function-name $FN \
  --query 'Versions[-2].Version' --output text)
aws lambda update-alias --function-name $FN --name live --function-version $PREV

# Rollback SFN to previous definition
aws stepfunctions update-state-machine \
  --state-machine-arn $SFN_ARN \
  --definition file://backup/sfn-definition-2026-05-20.json

# Rollback frontend
aws s3 sync s3://$S3_BUCKET/frontend-backup-2026-05-25/ s3://$S3_BUCKET/frontend/ --delete --sse AES256
aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/*"
```

Make backup snapshots of `frontend/` and SFN definition before any production deploy.
