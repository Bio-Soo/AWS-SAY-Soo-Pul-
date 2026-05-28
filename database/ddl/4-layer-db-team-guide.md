# Rare-Link AI · 4-Layer DB 팀 공유 가이드

**프로젝트:** SKKU AWS SAY 2기 2팀 Rare-Link AI  
**작성자:** 박성수  
**작성일:** 2026-05-11  
**상태:** Aurora PostgreSQL 16.4에 스키마 생성 완료 ✅

---

## 1. 이 문서는 뭔가요?

우리 시스템의 **데이터베이스가 어떻게 구성되어 있는지**, 그리고 **각 Phase 팀이 DB를 어떻게 사용해야 하는지** 설명하는 문서입니다.

각 Phase 담당자는 이 문서를 읽고:
- 내 Phase가 **어떤 테이블에서 데이터를 읽는지** (입력)
- 내 Phase가 **어떤 테이블에 결과를 쓰는지** (출력)
- 각 컬럼에 **어떤 형태의 데이터를 넣어야 하는지**

를 파악하면 됩니다.

---

## 2. 왜 이렇게 설계했나요?

### Q: EMR 데이터를 그대로 쓰면 안 되나요?

안 됩니다. 이유:

### (1) 법적 요구 — Audit Trail
EU AI Act에 따르면 의료 AI 시스템은 **모든 의사결정 과정을 재현**할 수 있어야 합니다. 6개월 후에 "이 환자한테 왜 이 진단을 내렸어?"라고 물으면, 당시 입력 데이터 + 모델 버전 + 출력 결과를 모두 보여줄 수 있어야 합니다.

### (2) Phase 간 독립성
Phase 3 팀이 Phase 1 코드를 몰라도 됩니다. DB 테이블 스키마만 알면 됩니다. 한 Phase가 실패해도 다른 Phase에 영향 없습니다.

### (3) 성능
Front 9개 화면이 동시에 데이터를 요청할 때, 매번 Phase 1→2→3→4를 처음부터 다시 실행하면 환자당 30초 이상 걸립니다. DB에 미리 계산된 결과를 저장해두면 100ms 이하로 응답 가능합니다.

### Q: EMR 원본이랑 Layer 1이 중복 아닌가요?

**의도적 중복**입니다.

```
Layer 0: EMR 원본 JSON 그대로 저장 (보험용, 절대 수정 금지)
Layer 1: 원본을 쪼개서 우리가 쓰기 편한 형태로 정규화 (SELECT 한 줄로 가져올 수 있게)
Layer 2: AI가 새로 만든 결과물 (원본에 없던 것)
Layer 3: 의사 피드백 (원본에 없던 것)
```

- **Layer 0**은 "원본 증거"입니다. 나중에 "원래 EMR에 뭐가 있었지?" 할 때 여기를 봅니다.
- **Layer 1**은 "작업용 복사본"입니다. Phase 1이 clinical_note를 읽을 때 FHIR Bundle JSON을 매번 파싱하는 게 아니라, 이미 정리된 `note_text_ko` 컬럼을 바로 SELECT합니다.

---

## 3. 전체 구조 한눈에 보기

```
┌─────────────────────────────────────────────────────────────────┐
│                        EMR (FHIR Server)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                    FHIR Bundle (JSON)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 0: raw_emr_bundle                                        │
│  → EMR 원본 그대로 저장 (절대 수정 금지!)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                     ETL (분해·정규화)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: canonical (정규화된 환자 데이터)                         │
│                                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────┐ ┌───────────┐ │
│  │patient_profile│ │clinical_note │ │lab_result │ │imaging_   │ │
│  │(환자 기본정보) │ │(의사 노트)    │ │(검사 결과) │ │study      │ │
│  └──────────────┘ └──────────────┘ └───────────┘ │(영상 메타) │ │
│                                                    └───────────┘ │
└─────────────────────────────────────────────────────────────────┘
         │                │                │              │
         ▼                ▼                ▼              ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Phase 1  │    │ Phase 2  │    │ Phase 3  │    │  Front   │
   │ Symptom  │    │ X-ray    │    │ Lab+LR   │    │ (읽기만) │
   │ LLM      │    │ UNet+    │    │ Ranking  │    │          │
   │          │    │ DenseNet │    │          │    │          │
   └────┬─────┘    └────┬─────┘    └────┬─────┘    └──────────┘
        │               │               │
        ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: phase_io (각 Phase의 결과물)                            │
│                                                                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────────┐ │
│  │phase1_hpo_      │ │phase2_xray_     │ │phase3_integrated_ │ │
│  │extraction       │ │processing       │ │ranking            │ │
│  │(HPO 추출 결과)   │ │(마스크+heatmap)  │ │(질환 순위)         │ │
│  └─────────────────┘ └─────────────────┘ └───────────────────┘ │
│                                                                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────────┐ │
│  │phase4_llm_      │ │final_report     │ │rag_api_cache      │ │
│  │rerank           │ │(최종 보고서)      │ │(외부 API 캐시)     │ │
│  │(LLM 검증)       │ │                 │ │                   │ │
│  └─────────────────┘ └─────────────────┘ └───────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: outcome_history (의사 피드백 + 사후 결과)                │
│                                                                  │
│  ┌─────────────────────┐  ┌─────────────────────────┐          │
│  │physician_feedback   │  │final_clinical_outcome   │          │
│  │(의사 동의/수정)       │  │(확진 결과)               │          │
│  └─────────────────────┘  └─────────────────────────┘          │
│                                                                  │
│  → 모델 재학습 데이터셋으로 활용                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 각 Layer 상세 설명

### Layer 0 — raw_emr (원본 보관)

| 테이블 | 설명 | 변경 정책 |
|--------|------|----------|
| `raw_emr_bundle` | EMR에서 받은 FHIR Bundle JSON 원본 | **절대 수정 금지** (INSERT만 가능) |

- UPDATE/DELETE 시도하면 트리거가 에러를 발생시킵니다.
- EMR 데이터가 변경되면 새로운 row로 INSERT합니다.
- "당시 EMR에 뭐가 있었는지" 증명하는 법적 증거입니다.

### Layer 1 — canonical (정규화)

| 테이블 | 설명 | 누가 읽나 |
|--------|------|----------|
| `patient_profile` | 환자 기본정보 (이름, 나이, 성별, 흡연, 직업) | Front, Phase 전체 |
| `clinical_note` | 의사 노트 원문 (한국어/영어) | **Phase 1** |
| `lab_result` | 검사 결과 (수치 + 정상범위 + 비정상 플래그) | **Phase 3** |
| `imaging_study` | 영상 메타데이터 + S3 URI | **Phase 2** |

- Layer 0의 FHIR Bundle을 분해해서 각 테이블에 정규화한 것입니다.
- 각 Phase는 자기에게 필요한 테이블만 읽으면 됩니다.

### Layer 2 — phase_io (AI 결과물)

| 테이블 | 설명 | 누가 쓰나 |
|--------|------|----------|
| `diagnosis_session` | 진단 세션 메타 (시작/종료/상태) | Orchestrator |
| `phase1_hpo_extraction` | HPO 추출 결과 | Phase 1 |
| `phase2_xray_processing` | 마스크 + heatmap + DenseNet 결과 | Phase 2 |
| `phase3_integrated_ranking` | 통합 LR 질환 순위 | Phase 3 |
| `phase4_llm_rerank` | LLM 검증 + 재랭킹 | Phase 4 |
| `final_report` | 최종 진단 보고서 (JSON + Markdown) | RAG |
| `rag_api_cache` | 외부 API 응답 캐시 | RAG |

- **이 Layer가 핵심입니다.** 각 Phase가 AI/ML로 새로 만든 결과물이 여기 저장됩니다.
- Front는 이 Layer에서 읽어서 화면에 표시합니다.

### Layer 3 — outcome_history (피드백)

| 테이블 | 설명 | 누가 쓰나 |
|--------|------|----------|
| `physician_feedback` | 의사가 시스템 결과에 동의/수정한 내용 | 의사 (UI) |
| `final_clinical_outcome` | 추후 확진된 최종 진단 | 의사 (UI) |

- 나중에 모델 재학습할 때 사용합니다.
- "시스템이 top3 안에 맞췄는지" 같은 성능 지표도 여기서 나옵니다.

---

## 5. Phase별 "나는 뭘 읽고 뭘 쓰면 되나요?"

### Phase 1 담당자 (Symptom LLM)

**읽기:**
```sql
-- 환자의 의사 노트를 가져옴
SELECT note_id, note_text_ko, note_type
FROM soopulai.clinical_note
WHERE patient_id = '환자ID'
  AND note_type IN ('chief_complaint', 'hpi', 'pe');
```

**쓰기:**
```sql
INSERT INTO soopulai.phase1_hpo_extraction (
    session_id, phase, input_note_ids,
    positive_hpo, negative_hpo,
    llm_model, korean_dict_ver, multilang_lex_ver,
    inference_time_ms
) VALUES (
    '세션UUID', 1, ARRAY['노트UUID1', '노트UUID2'],
    '[{"hpo": "HP:0002094", "label_ko": "호흡곤란", "confidence": 0.92}]'::jsonb,
    '[{"hpo": "HP:0002206", "label_ko": "흉막삼출 없음"}]'::jsonb,
    'claude-sonnet-4-20250514', 'v1', 'multilingual_phenotype_lexicon_v1',
    2340
);
```

---

### Phase 2 담당자 (X-ray UNet + DenseNet)

**읽기:**
```sql
-- 환자의 CXR 영상 정보를 가져옴
SELECT study_id, s3_uri_png, modality, view_position
FROM soopulai.imaging_study
WHERE patient_id = '환자ID'
  AND modality = 'CXR';
```

**쓰기:**
```sql
INSERT INTO soopulai.phase2_xray_processing (
    session_id, phase, study_id,
    -- S3 경로들
    s3_original_full, s3_original_512,
    s3_lung_mask_512, s3_heart_mask_512,
    s3_lung_masked_512, s3_overlay_viz_512,
    s3_heatmaps,
    -- UNet 메타
    unet_model_ver, lung_pixel_count, heart_pixel_count,
    ctr_estimate, mask_quality_flag,
    -- DenseNet 결과
    densenet_findings, densenet_model_ver,
    -- HPO 매핑
    xray_hpo_inferred,
    inference_time_ms
) VALUES (
    '세션UUID', 2, '스터디UUID',
    -- S3 경로들
    's3://say2-2team-bucket/Phase_2/imaging/환자ID/스터디ID/original/full_res.png',
    's3://say2-2team-bucket/Phase_2/imaging/환자ID/스터디ID/original/resized_512.png',
    's3://say2-2team-bucket/Phase_2/imaging/환자ID/스터디ID/masks/lung_mask_512.png',
    's3://say2-2team-bucket/Phase_2/imaging/환자ID/스터디ID/masks/heart_mask_512.png',
    's3://say2-2team-bucket/Phase_2/imaging/환자ID/스터디ID/masked/lung_masked_512.png',
    's3://say2-2team-bucket/Phase_2/imaging/환자ID/스터디ID/overlay/viz_512.png',
    -- heatmap (threshold 초과 양성만)
    '[{"finding": "Lung Opacity", "s3_uri": "s3://.../heatmaps/lung_opacity.png"},
      {"finding": "Pleural Effusion", "s3_uri": "s3://.../heatmaps/pleural_effusion.png"}]'::jsonb,
    -- UNet
    'unet-jsrt-v1', 145230, 42100, 0.48, 'good',
    -- DenseNet (14개 finding 전부)
    '[{"finding": "Lung Opacity", "prob": 0.87, "severity": "moderate"},
      {"finding": "Pleural Effusion", "prob": 0.12, "severity": "normal"}]'::jsonb,
    'densenet121-chexpert-v3',
    -- HPO 매핑 (Phase 3가 읽을 것)
    '[{"hpo": "HP:0002202", "from_finding": "Pleural Effusion", "prob": 0.12}]'::jsonb,
    4500
);
```

**S3 저장 경로 규칙:**
```
s3://say2-2team-bucket/Phase_2/imaging/{patient_id}/{study_id}/
├── original/
│   ├── full_res.png              ← 원본 해상도
│   └── resized_512.png           ← 512×512 (모델 입력)
├── masks/
│   ├── lung_mask_512.png         ← UNet 폐 마스크
│   └── heart_mask_512.png        ← UNet 심장 마스크
├── masked/
│   ├── lung_masked_512.png       ← 원본 × 폐 마스크
│   └── heart_masked_512.png
├── heatmaps/
│   ├── lung_opacity.png          ← threshold 초과 양성만!
│   ├── pleural_effusion.png
│   └── ...                       ← MIMIC처럼 환자별/이벤트별 저장
└── overlay/
    └── viz_512.png               ← Front 표시용
```

---

### Phase 3 담당자 (Lab + 통합 LR Ranking)

**읽기:**
```sql
-- Phase 1 결과 (HPO)
SELECT positive_hpo, negative_hpo
FROM soopulai.phase1_hpo_extraction
WHERE session_id = '세션UUID';

-- Phase 2 결과 (X-ray HPO)
SELECT xray_hpo_inferred, densenet_findings, mask_quality_flag
FROM soopulai.phase2_xray_processing
WHERE session_id = '세션UUID';

-- Lab 결과
SELECT loinc_code, test_name_ko, value_numeric, abnormal_flag, severity
FROM soopulai.lab_result
WHERE patient_id = '환자ID';
```

**쓰기:**
```sql
INSERT INTO soopulai.phase3_integrated_ranking (
    session_id, phase,
    lab_anomalies, lab_ref_ver,
    unified_positive_hpo, unified_negative_hpo,
    modality_weights, yaml_ssot_ver, rare_db_ver,
    stage1_filtered_count, stage2_full_lr_count,
    ranking, inference_time_ms
) VALUES (
    '세션UUID', 3,
    '[{"loinc": "1988-5", "name_ko": "CRP", "value": 7.2, "severity": "moderate", "hpo_mapped": "HP:0011227"}]'::jsonb,
    'lab_reference_ranges_v9_4',
    '통합 positive HPO (Phase1 + Phase2 + Lab)'::jsonb,
    '통합 negative HPO'::jsonb,
    '{"S": 0.4, "L": 0.2, "R": 0.3, "M": 0.1}'::jsonb,
    'lung_disease_profiles_v3_2', 'v7',
    30, 30,
    '[{"rank": 1, "orpha": "ORPHA:538", "name": "LAM", "lr_score": 12.35,
       "breakdown": {"S": 4.2, "L": 2.1, "R": 5.8, "M": 0.25},
       "matched_hpo": ["HP:0002094"], "missing_critical_hpo": []}]'::jsonb,
    1200
);
```

---

### Phase 4 담당자 (검증 LLM)

**읽기:**
```sql
-- Phase 1~3 전체 + 환자 정보
SELECT p1.positive_hpo, p1.negative_hpo,
       p2.densenet_findings, p2.xray_hpo_inferred,
       p3.ranking, p3.modality_weights,
       pp.age_years, pp.sex, pp.smoking_status
FROM soopulai.phase1_hpo_extraction p1
JOIN soopulai.phase2_xray_processing p2 ON p1.session_id = p2.session_id
JOIN soopulai.phase3_integrated_ranking p3 ON p1.session_id = p3.session_id
JOIN soopulai.diagnosis_session ds ON p1.session_id = ds.session_id
JOIN soopulai.patient_profile pp ON ds.patient_id = pp.patient_id
WHERE p1.session_id = '세션UUID';
```

**쓰기:**
```sql
INSERT INTO soopulai.phase4_llm_rerank (
    session_id, phase,
    agrees_with_top1, reranked,
    flagged_concerns, reasoning_summary, s3_reasoning_full,
    llm_model, prompt_ver, inference_time_ms
) VALUES (
    '세션UUID', 4,
    true,
    '[{"rank": 1, "orpha": "ORPHA:538", "confidence": "HIGH", "reason": "HPO 일치도 높음"}]'::jsonb,
    '["특이사항 없음"]'::jsonb,
    'Phase 3 top1 LAM과 동의. 호흡곤란+영상소견+VEGF-D 상승이 일관됨.',
    's3://say2-2team-bucket/Phase_4/reasoning/세션UUID/full_trace.json',
    'claude-sonnet-4-20250514', 'v3', 8500
);
```

---

### RAG 담당자 (Final Report)

**읽기:**
```sql
-- Phase 4 재랭킹 결과 (top 후보)
SELECT reranked FROM soopulai.phase4_llm_rerank WHERE session_id = '세션UUID';

-- 캐시 확인
SELECT response_json FROM soopulai.rag_api_cache
WHERE cache_key = 'orphanet:ORPHA:538' AND expires_at > NOW();
```

**쓰기:**
```sql
-- 최종 보고서
INSERT INTO soopulai.final_report (
    session_id, diagnosis_json, markdown_report,
    rag_citations, rag_apis_used, self_check,
    llm_model, total_inference_time_ms
) VALUES (...);

-- API 캐시 저장
INSERT INTO soopulai.rag_api_cache (
    cache_key, api_name, query_params, response_json, ttl_days,
    expires_at
) VALUES (
    'pubmed:HP:0002094:2024', 'pubmed',
    '{"hpo": "HP:0002094"}'::jsonb,
    '{...응답...}'::jsonb,
    7,
    NOW() + INTERVAL '7 days'
);
```

---

## 6. 핵심 규칙 (반드시 지켜야 할 것)

### 규칙 1: Phase 간 직접 호출 금지
```
❌ Phase 3 코드에서 Phase 1 함수를 import해서 호출
✅ Phase 3 코드에서 DB의 phase1_hpo_extraction 테이블을 SELECT
```

### 규칙 2: Layer 0은 절대 수정 금지
```
❌ UPDATE raw_emr_bundle SET ... WHERE ...
❌ DELETE FROM raw_emr_bundle WHERE ...
✅ INSERT INTO raw_emr_bundle (...) VALUES (...)  -- 새 row만 추가
```

### 규칙 3: S3 URI는 Front에 직접 노출 금지
```
❌ Front에 "s3://say2-2team-bucket/..." 그대로 전달
✅ Backend에서 presigned URL로 변환 후 전달 (TTL 5~15분)
```

### 규칙 4: 모든 Phase 결과에 모델 버전 기록
```
✅ llm_model = 'claude-sonnet-4-20250514'
✅ unet_model_ver = 'unet-jsrt-v1'
✅ densenet_model_ver = 'densenet121-chexpert-v3'
✅ yaml_ssot_ver = 'lung_disease_profiles_v3_2'
```
→ 나중에 "이 결과 어떤 모델로 나온 거야?" 추적 가능

---

## 7. DB 접속 정보

| 항목 | 값 |
|------|-----|
| Host | `patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com` |
| Port | 5432 |
| Database | `soopul` |
| Schema | `soopulai` |
| User | `app_user` |
| Password | AWS Secrets Manager `soopul/aurora/app-user` |

EC2에서 접속:
```bash
psql "host=patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com port=5432 dbname=soopul user=app_user password=<시크릿매니저에서가져온값>"
```

---

## 8. 테이블 전체 목록 (16개)

| # | Layer | 테이블 | 역할 | Owner |
|---|-------|--------|------|-------|
| 1 | 0 | `raw_emr_bundle` | EMR 원본 FHIR Bundle | app_user |
| 2 | 0 | `fhir_bundle_archive` | (기존) Bundle 감사 로그 | app_user |
| 3 | 1 | `patient_profile` | 환자 기본정보 | app_user |
| 4 | 1 | `clinical_note` | 의사 노트 원문 | app_user |
| 5 | 1 | `lab_result` | 검사 결과 | app_user |
| 6 | 1 | `imaging_study` | 영상 메타 + S3 URI | app_user |
| 7 | 2 | `diagnosis_session` | 진단 세션 메타 | app_user |
| 8 | 2 | `phase1_hpo_extraction` | HPO 추출 결과 | app_user |
| 9 | 2 | `phase2_xray_processing` | 마스크+heatmap+DenseNet | app_user |
| 10 | 2 | `phase3_integrated_ranking` | 통합 LR 질환 순위 | app_user |
| 11 | 2 | `phase4_llm_rerank` | LLM 검증 결과 | app_user |
| 12 | 2 | `final_report` | 최종 진단 보고서 | app_user |
| 13 | 2 | `rag_api_cache` | 외부 API 캐시 | app_user |
| 14 | 2 | `cxr_image_registry` | (기존) 이미지 fetch 추적 | app_user |
| 15 | 3 | `physician_feedback` | 의사 피드백 | app_user |
| 16 | 3 | `final_clinical_outcome` | 확진 결과 | app_user |

---

## 9. 질문이 있으면

- DB 스키마 관련: 박성수
- Phase 1 (Symptom LLM) 입출력: phase1_hpo_extraction 테이블 참고
- Phase 2 (X-ray) 입출력: phase2_xray_processing 테이블 + S3 경로 규칙 참고
- Phase 3 (Ranking) 입출력: phase3_integrated_ranking 테이블 참고
- Phase 4 (검증 LLM) 입출력: phase4_llm_rerank 테이블 참고
- RAG (Final Report) 입출력: final_report + rag_api_cache 테이블 참고

---

## 10. 관련 파일 위치

| 파일 | 위치 | 설명 |
|------|------|------|
| DDL (SQL) | `Architecture/4-layer-schema-ddl-v1.sql` | DB에 실행한 CREATE TABLE 문 |
| Phase IO 매핑 | `Architecture/4-layer-phase-io-mapping.md` | JSON 형태 상세 매핑 |
| 설계서 원본 | `rare-link-ai-4Layer-DB-v1.pdf` | 25페이지 설계 근거 문서 |
| S3 | `s3://say2-2team-bucket/database/` | DDL + 매핑 문서 백업 |
