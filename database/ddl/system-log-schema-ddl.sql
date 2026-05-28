-- ============================================================
-- Rare-Link AI · 시스템 실행 로그 테이블
-- Target: Aurora PostgreSQL 16.4 / Database: soopul / Schema: soopulai
--
-- 각 Phase(1~5) + RAG의 실행 결과/오류를 단일 테이블에 저장
-- ============================================================

SET search_path TO soopulai;

-- ══════════════════════════════════════════════════════════════
-- phase_execution_log: 모든 Phase 실행 이력 (성공/실패 모두)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS phase_execution_log (
    log_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID REFERENCES diagnosis_session,
    patient_id          VARCHAR(64),

    -- 어떤 Phase인지
    phase_name          VARCHAR(16) NOT NULL,        -- 'phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'rag'
    phase_step          VARCHAR(64),                 -- 세부 단계 (예: 'unet_mask', 'densenet_inference', 'api_pubmed')

    -- 실행 결과
    status              VARCHAR(16) NOT NULL,        -- 'started', 'success', 'failed', 'timeout', 'retrying'
    
    -- 타이밍
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    duration_ms         INT,                         -- 실행 시간 (ms)

    -- Lambda 메타
    lambda_function     VARCHAR(128),                -- 'symptom_to_hpo', 'phase2_xray', etc.
    lambda_request_id   VARCHAR(64),                 -- AWS Lambda Request ID
    lambda_memory_mb    INT,                         -- 할당 메모리
    lambda_billed_ms    INT,                         -- 과금 시간

    -- 입력 요약
    input_summary       JSONB,                       -- 입력 데이터 요약 (디버깅용)
    -- 예: {"note_count": 3, "image_count": 1, "lab_count": 12}

    -- 출력 요약
    output_summary      JSONB,                       -- 출력 데이터 요약
    -- 예: {"hpo_positive_count": 5, "hpo_negative_count": 2}

    -- 에러 정보 (status = 'failed' 일 때)
    error_code          VARCHAR(64),                 -- 'LLM_TIMEOUT', 'SAGEMAKER_ERROR', 'DB_CONNECTION', etc.
    error_message       TEXT,                        -- 에러 메시지 전문
    error_stacktrace    TEXT,                        -- Python traceback (디버깅용)
    error_category      VARCHAR(32),                 -- 'infra', 'model', 'data', 'external_api', 'validation'

    -- 재시도 정보
    retry_count         INT DEFAULT 0,
    retry_of_log_id     UUID,                        -- 재시도인 경우 원본 log_id

    -- 외부 서비스 호출 정보
    external_calls      JSONB,                       -- 외부 서비스 호출 기록
    -- [{"service": "bedrock", "model": "haiku", "latency_ms": 1200, "status": "success"},
    --  {"service": "sagemaker", "endpoint": "soonet-v1", "latency_ms": 3400, "status": "success"}]

    -- 모델/버전 정보 (재현성)
    model_versions      JSONB,                       -- 사용한 모델/데이터 버전
    -- {"llm": "claude-sonnet-4-20250514", "unet": "v1", "yaml_ssot": "v3_2"}

    -- 메타
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_log_session ON phase_execution_log (session_id, phase_name);
CREATE INDEX IF NOT EXISTS idx_log_patient ON phase_execution_log (patient_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_status ON phase_execution_log (status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_phase ON phase_execution_log (phase_name, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_error ON phase_execution_log (error_category, error_code) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_log_time ON phase_execution_log (started_at DESC);


-- ══════════════════════════════════════════════════════════════
-- system_health_metric: 시스템 전체 헬스 메트릭 (집계용)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_health_metric (
    metric_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metric_window       VARCHAR(8) NOT NULL,         -- '1h', '24h', '7d'

    -- Phase별 성공률
    phase1_success_rate NUMERIC(5,2),                -- 0.00 ~ 100.00
    phase2_success_rate NUMERIC(5,2),
    phase3_success_rate NUMERIC(5,2),
    phase4_success_rate NUMERIC(5,2),
    phase5_success_rate NUMERIC(5,2),
    rag_success_rate    NUMERIC(5,2),

    -- Phase별 평균 응답시간 (ms)
    phase1_avg_ms       INT,
    phase2_avg_ms       INT,
    phase3_avg_ms       INT,
    phase4_avg_ms       INT,
    phase5_avg_ms       INT,
    rag_avg_ms          INT,

    -- 전체 파이프라인
    total_sessions      INT,
    completed_sessions  INT,
    failed_sessions     INT,
    avg_total_pipeline_ms INT,                       -- 전체 파이프라인 평균 시간

    -- 에러 분포
    error_distribution  JSONB                        -- {"infra": 2, "model": 1, "data": 0, "external_api": 3}
);

CREATE INDEX IF NOT EXISTS idx_health_time ON system_health_metric (recorded_at DESC);


-- ══════════════════════════════════════════════════════════════
-- 유용한 뷰: 최근 에러 조회
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW recent_errors AS
SELECT 
    log_id,
    session_id,
    patient_id,
    phase_name,
    phase_step,
    error_code,
    error_category,
    error_message,
    started_at,
    duration_ms,
    lambda_function,
    retry_count
FROM phase_execution_log
WHERE status = 'failed'
ORDER BY started_at DESC
LIMIT 100;


-- ══════════════════════════════════════════════════════════════
-- 유용한 뷰: Phase별 성공률 (최근 24시간)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW phase_success_rates_24h AS
SELECT 
    phase_name,
    COUNT(*) AS total_executions,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0), 
        2
    ) AS success_rate_pct,
    ROUND(AVG(duration_ms) FILTER (WHERE status = 'success'), 0) AS avg_duration_ms,
    MAX(duration_ms) FILTER (WHERE status = 'success') AS max_duration_ms
FROM phase_execution_log
WHERE started_at > NOW() - INTERVAL '24 hours'
  AND status IN ('success', 'failed')
GROUP BY phase_name
ORDER BY phase_name;
