#!/usr/bin/env bash
# End-to-end smoke test: create session → run → poll → fetch report.
set -euo pipefail
[ -f .env ] || { echo "Need .env"; exit 1; }
source .env

BASE="https://$CLOUDFRONT_DOMAIN"
AUTH="Authorization: Bearer ${DEV_TOKEN:-dev-bypass}"
PATIENT="${TEST_PATIENT:-20-145982}"

echo "=== Soo-Pul E2E test ==="
echo "Endpoint: $BASE"
echo "Patient:  $PATIENT"
echo ""

echo "[1/4] Health..."
curl -sf "$BASE/health" && echo " ✓" || { echo " ✗"; exit 1; }

echo "[2/4] Create session..."
RESP=$(curl -sS -X POST "$BASE/api/v1/sessions" \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d "{\"patient_fhir_id\":\"$PATIENT\",\"symptom_text\":\"e2e verify $(date -u +%FT%TZ)\"}")
SID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['session_id'])")
echo "    session_id=$SID"

echo "[3/4] Start SFN run..."
curl -sS -X POST "$BASE/api/v1/sessions/$SID/run" -H "$AUTH" -o /dev/null -w "    HTTP %{http_code}\n"

echo "[4/4] Poll until completed (timeout 180s)..."
for i in $(seq 1 30); do
  RESP=$(curl -sS "$BASE/api/v1/sessions/$SID" -H "$AUTH")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  PROG=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['progress'])")
  printf "    [%02d] status=%s progress=%s\n" "$i" "$STATUS" "$PROG"
  [[ "$STATUS" =~ ^(completed|failed)$ ]] && break
  sleep 6
done

if [ "$STATUS" != "completed" ]; then
  echo "✗ Session did not complete. Final status: $STATUS"
  exit 2
fi

echo ""
echo "Final report:"
curl -sS "$BASE/api/v1/sessions/$SID/result" -H "$AUTH" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'detail' in d:
    print(' NOT READY:', d['detail']); sys.exit(2)
print(f'  llm_model:   {d[\"llm_model\"]}')
print(f'  citations:   {len(d[\"rag_citations\"])}')
print(f'  report len:  {len(d[\"markdown_report\"])} chars')
print(f'  rag_apis:    {d[\"rag_apis_used\"]}')
"

echo ""
echo "✓ E2E test passed."
