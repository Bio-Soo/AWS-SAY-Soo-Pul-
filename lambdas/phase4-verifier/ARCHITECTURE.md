# Phase 4 — LLM Verification + Reranking (AWS)

## 한 줄 요약
**API Gateway → Lambda → Bedrock InvokeModel (Claude Sonnet 4.6) → Guard Rail 6종 → JSON**.
Phase 3 ranking과 환자 컨텍스트를 받아 LLM이 임상 reasoning + citation으로 재평가.
Guard Rail 실패 시 Phase 3 결과를 그대로 반환 (safety-first).

## 데이터 흐름

```
[Client / Step Functions]
        │  POST /verify  (JSON: phase3_ranking + 환자 정보)
        ▼
[API Gateway REST API]
        ▼
[Lambda phase4-verifier]   memory=512MB  timeout=60s  runtime=python3.11
  │
  │  cold start:
  │    1) Phase4Verifier(mode='real', model_id='anthropic.claude-sonnet-4-6')
  │    2) bedrock-runtime client 초기화 (~200ms)
  │
  │  warm invocation:
  │    1) event.body JSON parse
  │    2) Phase4Input dataclass 생성
  │    3) verifier.verify(input_data)
  │       ├─ prompt_builder: system + user prompt 구성
  │       ├─ Bedrock InvokeModel (Claude Sonnet 4.6, temp=0.0)
  │       ├─ Response parse → revised_ranking + missed_alerts
  │       └─ Guard Rail 6종 적용 → 실패 시 Phase 3 fallback
  │    4) Phase4Result → asdict → JSON 응답
  │
  └────[Bedrock Runtime]
          ├─ 모델: anthropic.claude-sonnet-4-6
          ├─ region: us-east-1 (모델 가용성 확인)
          └─ guardrails: AWS Bedrock Guardrails 추가 (별건)
```

## Lambda 설정 근거

| 설정 | 값 | 근거 |
|---|---|---|
| runtime | python3.11 | lung_dx + boto3 ≥1.34 |
| memory | 512 MB | 핸들러 자체는 가벼움. Bedrock 호출이 시간 대부분 |
| timeout | 60 s | LLM 응답 p95 ≤ 30s. 여유 2배 |
| reservedConcurrency | 3 | Bedrock TPM 한도 고려 (계정 한도 확인 필수) |
| tracing | Active (X-Ray) | 의료 audit + Bedrock 호출 분리 추적 |

## API 입력 스펙 (JSON)

`POST /verify` body:

```json
{
  "phase3_ranking": [
    {
      "disease_key": "community_acquired_pneumonia",
      "score": 0.78,
      "hp_matches": ["HP:0012735", "HP:0001945"]
    },
    {
      "disease_key": "viral_pneumonia",
      "score": 0.61,
      "hp_matches": ["HP:0012735", "HP:0001945"]
    }
  ],
  "matched_hp_ids": ["HP:0012735", "HP:0001945", "HP:0002094"],
  "patient_age": 72,
  "patient_sex": "M",
  "patient_history": ["COPD 10y", "Type 2 DM"],
  "patient_medications": ["prednisone 10mg daily", "metformin 1000mg"],
  "xray_findings": ["right lower lobe consolidation"],
  "lab_summary": [
    {"name": "WBC", "value": 14.2, "unit": "K/uL", "interpretation": "High"},
    {"name": "CRP", "value": 120, "unit": "mg/L", "interpretation": "High"}
  ],
  "clinical_scores": {"CURB-65": 2, "qSOFA": 1, "NEWS2": 5},
  "mode": "real"
}
```

## API 출력 스펙 (JSON)

```json
{
  "revised_ranking": [
    {
      "rank": 1,
      "disease_key": "community_acquired_pneumonia",
      "score": 0.85,
      "rank_change": 0,
      "rationale": "고령 + 면역억제(스테로이드) + 우하엽 consolidation + WBC↑/CRP↑로 ATS/IDSA 2019 진단 기준 충족. CURB-65=2이므로 입원 고려.",
      "citations": [
        {"type": "guideline", "identifier": "ATS/IDSA CAP 2019", "year": 2019, "section": "Diagnosis", "title": "ATS/IDSA Community-acquired Pneumonia Guidelines"},
        {"type": "PMID", "identifier": "PMID:31573350", "year": 2019, "section": null, "title": "Metlay JP et al. AJRCCM"}
      ]
    }
  ],
  "missed_alerts": [
    {
      "disease_or_condition": "Pneumocystis jirovecii Pneumonia (PJP)",
      "rationale": "장기 스테로이드 + 면역저하 상태에서 PJP 감별 필요. β-D-glucan/PCR 권고.",
      "recommended_workup": ["Serum (1,3)-β-D-glucan", "Induced sputum PJP PCR", "BAL if non-diagnostic"],
      "citations": [
        {"type": "guideline", "identifier": "ECIL PCP 2016", "year": 2016, "section": null, "title": "ECIL Guidelines for PCP in Hematology"}
      ]
    }
  ],
  "overall_confidence": 0.82,
  "guard_rail_report": {
    "hp_id_validation_passed": true,
    "icd_mapping_validation_passed": true,
    "citation_required_passed": true,
    "confidence_threshold_passed": true,
    "hallucination_keyword_passed": true,
    "schema_validation_passed": true,
    "rejected_items": []
  },
  "raw_llm_response": "...(audit trail용 원문)...",
  "parse_success": true,
  "fallback_to_phase3": false,
  "mode": "real",
  "metadata": {
    "model_id": "anthropic.claude-sonnet-4-6",
    "request_id": "<lambda-request-id>",
    "elapsed_ms": 8421,
    "input_tokens": 1234,
    "output_tokens": 567
  }
}
```

## Bedrock 모델 호출 사양

- **model_id**: `anthropic.claude-sonnet-4-6` (lung_dx 코드 default)
- **temperature**: 0.0 (deterministic)
- **max_tokens**: 2048 (verifier.py 기본값)
- **system prompt**: AUTHORITATIVE_SOURCES 50+ 권위 출처만 인용 강제
- **input format**: Anthropic Messages API (Claude 3+ 호환)

## Guard Rail 6종 (코드 내부, AWS Guardrails와 별개)

| # | 이름 | 검증 내용 |
|---|---|---|
| 1 | hp_id_validation | revised_ranking의 disease가 input matched_hp_ids와 정합 |
| 2 | icd_mapping_validation | citation의 ICD가 disease와 매칭 |
| 3 | citation_required | 모든 ranking + alert에 1+ citation 필수 |
| 4 | confidence_threshold | overall_confidence ≥ 0.5 |
| 5 | hallucination_keyword | "may", "possibly", "perhaps" 등 비확정 키워드 빈도 검사 |
| 6 | schema_validation | output JSON이 Phase4Result schema 정합 |

**한 개라도 실패 → `fallback_to_phase3=true` + Phase 3 ranking 그대로 반환**.

## AWS Bedrock Guardrails (선택사항, 추가 layer)

코드 내부 Guard Rail에 더해 AWS Bedrock Guardrails 서비스 적용 가능:
- **Content filters**: hate, insults, sexual, violence (의료 컨텍스트라 violence는 카테고리 별 조정)
- **Word filters**: PHI 키워드 차단 (주민번호, 의료기록번호 패턴)
- **Sensitive information filter**: PII auto-redaction (NAME, EMAIL, PHONE, SSN)
- **Topic filter**: "non-medical advice 제공 금지" topic policy

template.yaml에 미포함 (계정별 활성화 필요). 운영 시 별도 추가 권고.

## 보안 / 컴플라이언스

- **PHI**: 환자 식별정보(이름/주민번호/의료기록번호) 입력 금지. 임상 정보(나이/성별/병력)만.
- **로깅**: Bedrock 입출력 raw text는 CloudWatch 미기록 (request_id + 메타만).
- **Bedrock 데이터 정책 (2024)**: AWS는 Anthropic 모델 입력을 모델 학습에 사용하지 않음 (Bedrock FAQ). BAA 체결 시 HIPAA-eligible.
- **암호화**: API GW HTTPS, Bedrock TLS, CloudWatch CMK 권장.
- **권한**: Lambda role은 `bedrock:InvokeModel` (모델 ARN 한정) + logs only.
- **VPC**: PHI 운영 시 Bedrock VPC Endpoint 사용 권고 (인터넷 미통과).

## 비용 (대략 추정, 2026-05 기준)

- **Lambda**: 512MB × 평균 10s = 5GB-s × $0.0000167/GB-s ≈ $0.0000835/호출
- **Bedrock Claude Sonnet 4.6** (참고치, 실시간 가격은 AWS 공식 문서 확인):
  - input: ~$3/MTok
  - output: ~$15/MTok
  - 평균 1500 input + 600 output → ≈ $0.0135/호출
- **API Gateway**: $3.50/M requests
- **합계 (1만 호출/월)**: ≈ $135 (Bedrock이 압도적 대부분)

## 로컬 테스트 (Mock 모드)

`mode: "mock"` 입력 시 Bedrock 호출 없이 verifier가 fixture 응답 사용.
AWS 인증 없이 핸들러 로직 검증 가능.

```bash
./invoke_local.sh
# events/sample_event.json의 mode="mock" 으로 실행
```

## 배포

```bash
./deploy.sh dev   # 또는 prod
```

배포 전 사전 작업:
1. AWS 콘솔 → Bedrock → Model access → Anthropic Claude Sonnet 모델 활성화
2. (HIPAA 운영 시) AWS BAA 체결 확인
3. (운영) AWS Bedrock Guardrails 정의 → guardrailIdentifier 환경변수 추가

## 모니터링

- **CloudWatch Logs**: `/aws/lambda/phase4-verifier`
- **CloudWatch Metrics**: Lambda Errors / Duration / Throttles + Bedrock InvokeModel count
- **X-Ray**: Lambda → Bedrock segment 분리 (latency 분석)
- **알람** (template.yaml): Error > 1%, Bedrock throttle, p99 > 30s, fallback rate > 20%

## 알려진 제약

1. **Bedrock 리전 가용성** — Claude Sonnet 4.6는 us-east-1, us-west-2 등 특정 리전. 한국 서비스 시 ap-northeast-2 가용성 시점 확인 필요.
2. **Bedrock 계정 한도** — 기본 TPM/RPM 제한. Service Quotas 통해 증액 신청.
3. **JSON 파싱 실패** — 코드 fallback 보장하지만 정상 응답률 모니터링 필수.
4. **AUTHORITATIVE_SOURCES 갱신** — prompt_builder.py hardcoded. 가이드라인 신판(2026 GOLD 등) 추가 시 코드 갱신 + 재배포.

## 향후 작업 (별건)

- [ ] AWS Bedrock Guardrails 정책 정의 + 적용
- [ ] PII redaction layer (입력 단계)
- [ ] Bedrock Streaming 지원 (현재 sync invoke)
- [ ] A/B 테스트 (Claude Sonnet 4.6 vs Opus 4.7)
- [ ] LLM 응답 캐시 (동일 입력 dedup, S3+DynamoDB)
- [ ] Audit log → CloudWatch Logs Insights 쿼리 sample
