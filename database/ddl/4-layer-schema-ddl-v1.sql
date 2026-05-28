-- ============================================================
-- Rare-Link AI · 4-Layer DB Schema DDL v1.0
-- Target: Aurora PostgreSQL 16.4 / Database: soopul / Schema: soopulai
-- 
-- 기존 테이블: fhir_bundle_archive, cxr_image_registry (유지)
-- 신규 테이블: 4-Layer 설계서 기반 전체 추가
--
-- 실행 방법: psql로 soopul DB에 app_user 또는 postgres로 접속 후 실행
-- ============================================================

SET search_path TO soopulai;

-- ══════════════════════════════════════════════════════════════
-- Layer 0: raw_emr (Immutable)
-- 기존 fhir_bundle_archive를 Layer 0으로 활용.
-- 추가로 raw_emr_bundle 테이블 생성 (설계서 §3.1 준수)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS raw_emr_bundle (
    bundle_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          VARCHAR(64) NOT NULL,
    encounter_id        VARCHAR(64),
    source_system       VARCHAR(32) NOT NULL,       -- 'smart_sandbox', 'hapi_self_hosted', 'synthea'
    fhir_bundle_json    JSONB NOT NULL,
    fhir_version        VARCHAR(8) DEFAULT 'R4',
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fetched_by          VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_raw_emr_patient ON raw_emr_bundle (patient_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_emr_encounter ON raw_emr_bundle (encounter_id);

-- Immutable 보장 트리거
CREATE OR REPLACE FUNCTION soopulai.prevent_update_raw_emr()
RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'raw_emr_bundle is immutable'; END; $$
LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS raw_emr_immutable ON raw_emr_bundle;
CREATE TRIGGER raw_emr_immutable BEFORE UPDATE OR DELETE ON raw_emr_bundle
FOR EACH ROW EXECUTE FUNCTION soopulai.prevent_update_raw_emr();


-- ══════════════════════════════════════════════════════════════
-- Layer 1: canonical (정규화된 환자 데이터)
-- ══════════════════════════════════════════════════════════════

-- 4.1 patient_profile
CREATE TABLE IF NOT EXISTS patient_profile (
    patient_id          VARCHAR(64) PRIMARY KEY,
    bundle_id           UUID NOT NULL REFERENCES raw_emr_bundle(bundle_id),
    -- 인구통계
    name_display        TEXT,
    birth_date          DATE,
    age_years           INT,
    sex                 VARCHAR(8),
    mrn                 VARCHAR(64),
    -- 임상 단서
    ethnicity           VARCHAR(32),
    smoking_status      VARCHAR(16),
    pack_years          NUMERIC,
    occupation          VARCHAR(64),
    family_history      JSONB,
    -- 메타
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_mrn ON patient_profile (mrn);

-- 4.2 clinical_note
CREATE TABLE IF NOT EXISTS clinical_note (
    note_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          VARCHAR(64) NOT NULL REFERENCES patient_profile,
    encounter_id        VARCHAR(64),
    note_type           VARCHAR(16),                -- 'chief_complaint', 'hpi', 'pe', 'imp', 'discharge'
    note_text_ko        TEXT NOT NULL,
    note_text_en        TEXT,
    language            VARCHAR(8) DEFAULT 'ko',
    author_role         VARCHAR(16),
    recorded_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_patient ON clinical_note (patient_id, recorded_at DESC);

-- 4.3 lab_result
CREATE TABLE IF NOT EXISTS lab_result (
    lab_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          VARCHAR(64) NOT NULL,
    encounter_id        VARCHAR(64),
    -- 검사 식별
    loinc_code          VARCHAR(16),
    test_name_ko        VARCHAR(64),
    test_name_en        VARCHAR(64),
    -- 결과
    value_numeric       NUMERIC,
    value_text          VARCHAR(64),
    value_unit          VARCHAR(16),
    -- 정상범위
    reference_low       NUMERIC,
    reference_high      NUMERIC,
    reference_ver       VARCHAR(16),
    -- 해석
    abnormal_flag       VARCHAR(8),                 -- 'H', 'L', 'HH', 'LL', 'N'
    severity            VARCHAR(16),                -- 'normal', 'mild', 'moderate', 'critical'
    measured_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lab_patient_time ON lab_result (patient_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_loinc ON lab_result (loinc_code);

-- 4.4 imaging_study
CREATE TABLE IF NOT EXISTS imaging_study (
    study_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          VARCHAR(64) NOT NULL,
    encounter_id        VARCHAR(64),
    modality            VARCHAR(8) NOT NULL,        -- 'CXR', 'CT', 'HRCT'
    view_position       VARCHAR(8),                 -- 'PA', 'AP', 'LAT'
    s3_uri_dicom        TEXT,
    s3_uri_png          TEXT NOT NULL,              -- PNG 변환본
    width_px            INT,
    height_px           INT,
    acquired_at         TIMESTAMPTZ NOT NULL,
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imaging_patient ON imaging_study (patient_id, acquired_at DESC);


-- ══════════════════════════════════════════════════════════════
-- Layer 2: phase_io (각 Phase 입출력)
-- ══════════════════════════════════════════════════════════════

-- 5.1 diagnosis_session
CREATE TABLE IF NOT EXISTS diagnosis_session (
    session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          VARCHAR(64) NOT NULL REFERENCES patient_profile,
    encounter_id        VARCHAR(64),
    bundle_id           UUID NOT NULL REFERENCES raw_emr_bundle,
    initiated_by        VARCHAR(64) NOT NULL,
    initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status              VARCHAR(16) NOT NULL,       -- 'running', 'completed', 'failed', 'cancelled'
    current_phase       INT,                        -- 1~5, NULL=완료
    completed_at        TIMESTAMPTZ,
    error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_patient ON diagnosis_session (patient_id, initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_status ON diagnosis_session (status, initiated_at DESC);

-- 5.2 phase1_hpo_extraction
CREATE TABLE IF NOT EXISTS phase1_hpo_extraction (
    session_id          UUID NOT NULL REFERENCES diagnosis_session,
    phase               INT NOT NULL DEFAULT 1,
    -- 입력 추적
    input_note_ids      UUID[] NOT NULL,
    -- 출력
    positive_hpo        JSONB NOT NULL,
    -- [{"hpo": "HP:0002094", "label_en": "Dyspnea", "label_ko": "호흡곤란",
    --   "source_quote": "점진적 호흡곤란", "confidence": 0.92}]
    negative_hpo        JSONB NOT NULL,
    -- 메타
    llm_model           VARCHAR(64) NOT NULL,
    korean_dict_ver     VARCHAR(16),
    multilang_lex_ver   VARCHAR(16),
    inference_time_ms   INT,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, phase)
);

-- 5.3 phase2_xray_processing
CREATE TABLE IF NOT EXISTS phase2_xray_processing (
    session_id          UUID NOT NULL REFERENCES diagnosis_session,
    phase               INT NOT NULL DEFAULT 2,
    study_id            UUID NOT NULL REFERENCES imaging_study,
    -- S3 URI들
    s3_original_full    TEXT NOT NULL,              -- 원본 전체 해상도 PNG
    s3_original_512     TEXT NOT NULL,              -- 512×512 리사이즈 (모델 입력)
    s3_lung_mask_512    TEXT NOT NULL,              -- UNet 폐 마스크 (binary 1ch)
    s3_heart_mask_512   TEXT NOT NULL,              -- UNet 심장 마스크
    s3_lung_masked_512  TEXT,                       -- 원본 × 폐 마스크 (DenseNet 입력)
    s3_heart_masked_512 TEXT,
    s3_overlay_viz_512  TEXT,                       -- Front 표시용 컬러 오버레이
    -- DenseNet heatmap 결과 (threshold 초과 양성 판정된 것들)
    s3_heatmaps         JSONB,                      -- [{"finding": "Lung Opacity", "s3_uri": "s3://..."}]
    -- UNet 메타
    unet_model_ver      VARCHAR(32) NOT NULL,
    lung_pixel_count    INT,
    heart_pixel_count   INT,
    ctr_estimate        NUMERIC,                    -- Cardiothoracic ratio
    mask_quality_flag   VARCHAR(16),                -- 'good', 'partial', 'failed'
    -- DenseNet 결과 (CheXpert 14 라벨)
    densenet_findings   JSONB NOT NULL,
    -- [{"finding": "Lung Opacity", "prob": 0.87, "severity": "moderate"}]
    densenet_model_ver  VARCHAR(32) NOT NULL,
    -- X-ray HPO 매핑 (Phase 3가 직접 읽는 필드)
    xray_hpo_inferred   JSONB,
    -- [{"hpo": "HP:0002202", "from_finding": "Pleural Effusion", "prob": 0.87}]
    inference_time_ms   INT,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, phase, study_id)
);

-- 5.4 phase3_integrated_ranking
CREATE TABLE IF NOT EXISTS phase3_integrated_ranking (
    session_id          UUID NOT NULL REFERENCES diagnosis_session,
    phase               INT NOT NULL DEFAULT 3,
    -- Lab 처리
    lab_anomalies       JSONB,
    lab_ref_ver         VARCHAR(16),
    -- 통합 input snapshot
    unified_positive_hpo JSONB NOT NULL,
    unified_negative_hpo JSONB NOT NULL,
    -- 가중치
    modality_weights    JSONB NOT NULL,
    yaml_ssot_ver       VARCHAR(32) NOT NULL,
    rare_db_ver         VARCHAR(16) NOT NULL,
    -- 2-stage filtering
    stage1_filtered_count INT,
    stage2_full_lr_count  INT,
    -- 최종 ranking
    ranking             JSONB NOT NULL,
    -- [{"rank": 1, "orpha": "ORPHA:538", "name": "LAM", "lr_score": 12.35,
    --   "breakdown": {"S": 4.2, "L": 2.1, "R": 5.8, "M": 0.25},
    --   "matched_hpo": [...], "missing_critical_hpo": []}]
    inference_time_ms   INT,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, phase)
);

-- 5.5 phase4_llm_rerank
CREATE TABLE IF NOT EXISTS phase4_llm_rerank (
    session_id          UUID NOT NULL REFERENCES diagnosis_session,
    phase               INT NOT NULL DEFAULT 4,
    -- 검증 결과
    agrees_with_top1    BOOLEAN,
    reranked            JSONB NOT NULL,
    -- [{"rank": 1, "orpha": "ORPHA:538", "confidence": "HIGH", "reason": "..."}]
    flagged_concerns    JSONB,
    reasoning_summary   TEXT,
    s3_reasoning_full   TEXT,                       -- 전체 reasoning trace S3 URI
    -- 메타
    llm_model           VARCHAR(64) NOT NULL,
    prompt_ver          VARCHAR(16),
    inference_time_ms   INT,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, phase)
);

-- 5.6 final_report
CREATE TABLE IF NOT EXISTS final_report (
    session_id          UUID PRIMARY KEY REFERENCES diagnosis_session,
    -- 핵심 출력
    diagnosis_json      JSONB NOT NULL,
    markdown_report     TEXT NOT NULL,
    -- RAG 추적
    rag_citations       JSONB NOT NULL,
    rag_apis_used       VARCHAR(64)[],
    -- 자가 검증
    self_check          JSONB NOT NULL,
    -- 메타
    llm_model           VARCHAR(64),
    total_inference_time_ms INT,
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5.7 rag_api_cache
CREATE TABLE IF NOT EXISTS rag_api_cache (
    cache_key           VARCHAR(256) PRIMARY KEY,
    api_name            VARCHAR(32) NOT NULL,
    query_params        JSONB NOT NULL,
    response_json       JSONB NOT NULL,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ttl_days            INT NOT NULL,
    expires_at          TIMESTAMPTZ GENERATED ALWAYS AS
                        (fetched_at + (ttl_days || ' days')::INTERVAL) STORED
);

CREATE INDEX IF NOT EXISTS idx_rag_cache_expires ON rag_api_cache (expires_at);


-- ══════════════════════════════════════════════════════════════
-- Layer 3: outcome_history (의사 피드백·사후 결과)
-- ══════════════════════════════════════════════════════════════

-- 6.1 physician_feedback
CREATE TABLE IF NOT EXISTS physician_feedback (
    feedback_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID NOT NULL REFERENCES diagnosis_session,
    physician_id        VARCHAR(64) NOT NULL,
    agreed_with_top1    BOOLEAN,
    selected_diagnosis  VARCHAR(64),
    override_reason     TEXT,
    ui_rating           INT,
    reasoning_quality   INT,
    freeform_comment    TEXT,
    reviewed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON physician_feedback (session_id);

-- 6.2 final_clinical_outcome
CREATE TABLE IF NOT EXISTS final_clinical_outcome (
    outcome_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID NOT NULL REFERENCES diagnosis_session,
    confirmed_diagnosis VARCHAR(64) NOT NULL,
    confirmation_method VARCHAR(32),
    confirmed_at        TIMESTAMPTZ,
    time_to_diagnosis_days INT,
    was_in_top3         BOOLEAN,
    was_in_top10        BOOLEAN,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by         VARCHAR(64)
);


-- ══════════════════════════════════════════════════════════════
-- updated_at 자동 갱신 트리거 (Layer 1 테이블용)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION soopulai.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_updated ON patient_profile;
CREATE TRIGGER trg_patient_updated
BEFORE UPDATE ON patient_profile
FOR EACH ROW EXECUTE FUNCTION soopulai.set_updated_at();
