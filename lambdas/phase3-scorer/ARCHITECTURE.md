# Phase 3 — Multimodal Weighted Scoring (AWS)

## 한 줄 요약
**API Gateway → Lambda (handler.py) → DiagnosticScorer.score_all() → JSON**.
Lambda는 Layer로 첨부된 disease registry (YAML+Excel) + lung_dx 코드를 사용한다.

## 데이터 흐름

```
[Client / Step Functions]
        │  POST /score  (JSON body)
        ▼
[API Gateway REST API]
        │  proxy integration
        ▼
[Lambda phase3-scorer]   memory=2048MB  timeout=30s  runtime=python3.11
  │
  │  cold start:
  │    1) /opt/python/lung_dx 패키지 import
  │    2) DiseaseRegistry().load() — 528 질환 로드 (~2s)
  │    3) DiagnosticScorer(registry) 생성
  │    4) 글로벌 변수 캐싱 → 다음 invocation 재사용
  │
  │  warm invocation:
  │    1) event.body JSON parse
  │    2) LabFinding/MicroFinding/SymptomMatch dataclass 생성
  │    3) scorer.score_all(...) 호출 (typical <500ms)
  │    4) DiseaseScore 리스트 → asdict → JSON 응답
  │
  └──[Layer phase3-data]   /opt/data/*.yaml + *.xlsx
     [Layer phase3-deps]   /opt/python/lung_dx/ + yaml/openpyxl deps
```

## Lambda 설정 근거

| 설정 | 값 | 근거 |
|---|---|---|
| runtime | python3.11 | lung_dx 코드 호환, 3.12는 일부 deps 미테스트 |
| memory | 2048 MB | 528 질환 + 146 lab item 인덱싱 시 ~600MB peak. 메모리=CPU 비례 (AWS Lambda 가격 모델) |
| timeout | 30 s | cold start ~5s + 처리 ~500ms. 안전 마진 6배 |
| reservedConcurrency | 5 | MVP. 실 트래픽 측정 후 조정 |
| tracing | Active (X-Ray) | observability 필수 (의료 audit) |
| log retention | 90 days | HIPAA 권고 6년이지만 별도 S3 export로 처리 |

## API 입력 스펙 (JSON)

`POST /score` body:

```json
{
  "patient_lab_findings": [
    {
      "itemid": 50912,
      "name": "Creatinine",
      "value": 1.8,
      "unit": "mg/dL",
      "ref_lower": 0.6,
      "ref_upper": 1.2,
      "interpretation": "High",
      "medical_term": "Elevated creatinine",
      "severity": "abnormal",
      "category": "blood_chem",
      "hpo_id": "HP:0003259"
    }
  ],
  "patient_micro_findings": [
    {"organism": "Streptococcus pneumoniae", "matched_diseases": []}
  ],
  "patient_symptom_matches": [
    {"symptom": "cough", "hpo_id": "HP:0012735", "hpo_kr": "기침", "frequency": "very_frequent"}
  ],
  "phase1_result": {
    "detected_findings": [
      {"finding": "consolidation", "present": true, "probability": 0.87, "ai_keywords": ["consolidation"], "icd10_codes": ["J18"]}
    ],
    "candidate_icd_codes": ["J18", "J13", "J14"]
  },
  "scoring_results": [
    {"name": "CURB-65", "score": 2, "interpretation": "moderate", "components": {}}
  ],
  "top_n": 10,
  "include_rare": false
}
```

## API 출력 스펙 (JSON)

```json
{
  "results": [
    {
      "disease_key": "community_acquired_pneumonia",
      "name_en": "Community-Acquired Pneumonia",
      "name_kr": "지역사회획득 폐렴",
      "category": "yaml",
      "icd10_codes": ["J13", "J14", "J15", "J18"],
      "total_score": 0.78,
      "confidence": "HIGH",
      "evidence": [
        {"axis": "S", "matched": ["cough"], "score": 0.65},
        {"axis": "L", "matched": ["Elevated CRP"], "score": 0.5},
        {"axis": "R", "matched": ["consolidation"], "score": 0.87},
        {"axis": "M", "matched": ["S. pneumoniae"], "score": 1.0}
      ]
    }
  ],
  "metadata": {
    "registry_version": "v3.2",
    "registry_loaded_at": "2026-05-07T10:00:00Z",
    "request_id": "<lambda-request-id>",
    "elapsed_ms": 412
  }
}
```

## Layer 구성

### `phase3-data` (자주 갱신, 빠른 layer 단독 배포)
```
/opt/data/
  ├── lung_disease_profiles_v3_2.yaml
  ├── lab_reference_ranges_v9_5.yaml
  ├── 일반_폐질환_데이터베이스_v7.xlsx
  ├── 기타_폐관련_질환_데이터베이스_v7.xlsx
  └── 희귀_폐질환_데이터베이스_v5.xlsx
```

### `phase3-deps` (드물게 갱신)
```
/opt/python/
  ├── lung_dx/                    # 프로젝트 코드 (phase3 + 의존 모듈)
  ├── yaml/                       # PyYAML
  ├── openpyxl/                   # Excel reader
  └── ...
```

## 보안 / 컴플라이언스

- **PHI**: 입력에 환자 식별정보 포함 금지. lab/symptom/HPO만 전송 권고.
- **로깅**: lab value 자체를 CloudWatch에 기록하지 않음 (handler에서 redact).
- **암호화**: API GW HTTPS 강제 (TLS 1.2+), Lambda 환경변수 KMS 암호화.
- **권한**: Lambda execution role은 logs:CreateLogStream/PutLogEvents 만. S3/DDB 미사용.
- **VPC**: MVP는 public Lambda. PHI 운영 시 VPC + Endpoint 권고.

## 로컬 테스트

```bash
# 1) layer 빌드 (data + lung_dx)
./layer/build_layer.sh

# 2) SAM local invoke
./invoke_local.sh
# → events/sample_event.json 입력으로 핸들러 직접 실행
```

## 배포

```bash
./deploy.sh dev   # 또는 prod
```

## 모니터링 (deploy 후 설정)

- **CloudWatch Logs**: `/aws/lambda/phase3-scorer`
- **CloudWatch Metrics**: Invocations / Errors / Duration / Throttles
- **X-Ray**: cold start 분리 추적
- **알람** (template.yaml에 정의): Error rate > 1%, p99 duration > 5s

## 알려진 제약

1. **콜드 스타트 ~5s** — 첫 호출 지연. ProvisionedConcurrency 설정 시 제거 가능 (월 추가비용).
2. **Layer 250MB 한도** — 현재 ~150MB로 여유 있음. 데이터 추가 시 모니터링.
3. **registry singleton** — Lambda 컨테이너 재시작 시 재로드 (5-10분 idle 후).
4. **registry 갱신** — YAML 변경 후 layer 재빌드 + Lambda publish 필요 (자동 hook은 별도 작업).

## 향후 작업 (별건)

- [ ] Provisioned Concurrency 설정 (production)
- [ ] DLQ (Dead Letter Queue) 설정 — 실패 이벤트 회수
- [ ] WAF 연동 (rate limit + geo block)
- [ ] X-Ray Custom segment 추가 (registry load / scoring 분리 측정)
- [ ] CloudWatch Logs Insights 쿼리 sample 작성
