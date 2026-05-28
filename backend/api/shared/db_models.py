"""SQLAlchemy ORM 모델 — Aurora PostgreSQL `soopulai` 스키마.

각 모델은 production Aurora (`patient-db-cluster`) 의 실제 컬럼과 1:1 매칭.
스키마 reference: s3://say2-2team-bucket/scripts/4-layer-schema-ddl-v1.1.sql + production
information_schema (2026-05-18 SSM psql 검증).

phase Lambda 들이 INSERT 하는 컬럼과 ORM 이 동일해야 SELECT/INSERT 가 동작.
phase1~5 + final_report 의 진실 출처는 production schema (v1.1 + 그 후 컬럼 추가).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON, Boolean, Column, DateTime, ForeignKey, Integer, Numeric, String, Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()
SCHEMA = "soopulai"


# ================================================================
# Diagnosis Session · orchestrator 상태 추적
# Production schema: session_id PK, patient_id FK, encounter_id, bundle_id FK,
#   initiated_by, initiated_at, status, current_phase, completed_at, error_message,
#   phase_states (JSONB — v1.1 이후 추가)
# ================================================================
class DiagnosisSession(Base):
    __tablename__ = "diagnosis_session"
    __table_args__ = {"schema": SCHEMA}

    session_id     = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_id     = Column(String(64), nullable=False, index=True)
    encounter_id   = Column(String(64))
    bundle_id      = Column(UUID(as_uuid=True))                # FK to raw_emr_bundle
    initiated_by   = Column(String(64), nullable=False, index=True)
    initiated_at   = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    status         = Column(String(16), nullable=False, default="initiated", index=True)
    current_phase  = Column(Integer)                           # 0~6
    completed_at   = Column(DateTime(timezone=True))
    error_message  = Column(Text)
    # FastAPI metadata (execution_arn, frontend_payload, phase progress 등). v1.1 이후 추가됨.
    phase_states   = Column(JSONB, default=dict)


# ================================================================
# Phase 1 · Symptom LLM (HPO 추출)
# Composite PK (session_id, phase, executed_at) — phase=1 고정
# ================================================================
class Phase1Result(Base):
    """phase1_hpo_extraction — phase1-symptom Lambda (또는 다른 LLM caller) 가 INSERT."""
    __tablename__ = "phase1_hpo_extraction"
    __table_args__ = {"schema": SCHEMA}

    session_id        = Column(UUID(as_uuid=True),
                               ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                               primary_key=True)
    phase             = Column(Integer, primary_key=True, default=1)
    executed_at       = Column(DateTime(timezone=True), primary_key=True,
                               default=datetime.utcnow)
    input_note_ids    = Column(ARRAY(UUID(as_uuid=True)))      # clinical_note FK list
    positive_hpo      = Column(JSONB, nullable=False)
    negative_hpo      = Column(JSONB, nullable=False)
    llm_model         = Column(String(64))
    korean_dict_ver   = Column(String(16))
    multilang_lex_ver = Column(String(16))
    inference_time_ms = Column(Integer)
    # production 추가 (v1.1 이후)
    unmapped_terms    = Column(JSONB)
    extraction_stats  = Column(JSONB)


# ================================================================
# Phase 2 · X-ray UNet + DenseNet
# Composite PK (session_id, phase, study_id, executed_at) — phase=2 고정
# ================================================================
class Phase2Result(Base):
    """phase2_xray_processing — say2-2team-phase2-vision Lambda 가 INSERT."""
    __tablename__ = "phase2_xray_processing"
    __table_args__ = {"schema": SCHEMA}

    session_id          = Column(UUID(as_uuid=True),
                                 ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                                 primary_key=True)
    phase               = Column(Integer, primary_key=True, default=2)
    study_id            = Column(UUID(as_uuid=True), primary_key=True)
    executed_at         = Column(DateTime(timezone=True), primary_key=True,
                                 default=datetime.utcnow)
    s3_original_full    = Column(Text, nullable=False)
    s3_original_512     = Column(Text, nullable=False)
    s3_lung_mask_512    = Column(Text, nullable=False)
    s3_heart_mask_512   = Column(Text, nullable=False)
    s3_lung_masked_512  = Column(Text)
    s3_heart_masked_512 = Column(Text)
    s3_overlay_viz_512  = Column(Text)
    s3_heatmaps         = Column(JSONB)
    unet_model_ver      = Column(String(32))
    lung_pixel_count    = Column(Integer)
    heart_pixel_count   = Column(Integer)
    ctr_estimate        = Column(Numeric)
    mask_quality_flag   = Column(String(16))                   # good | fair | poor
    densenet_findings   = Column(JSONB, nullable=False)        # [{label, score}, ...]
    densenet_model_ver  = Column(String(32))
    xray_hpo_inferred   = Column(JSONB)
    inference_time_ms   = Column(Integer)


# ================================================================
# Phase 3 · Lab + 통합 LR Ranking
# Composite PK (session_id, phase, executed_at) — phase=3 고정
# ================================================================
class Phase3Result(Base):
    """phase3_integrated_ranking — phase3-scorer-dev Lambda 가 INSERT."""
    __tablename__ = "phase3_integrated_ranking"
    __table_args__ = {"schema": SCHEMA}

    session_id            = Column(UUID(as_uuid=True),
                                   ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                                   primary_key=True)
    phase                 = Column(Integer, primary_key=True, default=3)
    executed_at           = Column(DateTime(timezone=True), primary_key=True,
                                   default=datetime.utcnow)
    lab_anomalies         = Column(JSONB)
    lab_ref_ver           = Column(String(16))
    unified_positive_hpo  = Column(JSONB, nullable=False)
    unified_negative_hpo  = Column(JSONB, nullable=False)
    modality_weights      = Column(JSONB, nullable=False)
    yaml_ssot_ver         = Column(String(32))
    rare_db_ver           = Column(String(16))
    stage1_filtered_count = Column(Integer)
    stage2_full_lr_count  = Column(Integer)
    ranking               = Column(JSONB, nullable=False)      # [{orpha, name, score, hp_matches[]}, ...]
    inference_time_ms     = Column(Integer)
    # production 추가 (v1.1 이후)
    scoring               = Column(JSONB)
    scoring_process       = Column(JSONB)


# ================================================================
# Phase 4 · 검증 LLM (Rerank)
# Composite PK (session_id, phase, executed_at) — phase=4 고정
# ================================================================
class Phase4Result(Base):
    """phase4_llm_rerank — phase4-verifier-dev Lambda 가 INSERT."""
    __tablename__ = "phase4_llm_rerank"
    __table_args__ = {"schema": SCHEMA}

    session_id          = Column(UUID(as_uuid=True),
                                 ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                                 primary_key=True)
    phase               = Column(Integer, primary_key=True, default=4)
    executed_at         = Column(DateTime(timezone=True), primary_key=True,
                                 default=datetime.utcnow)
    agrees_with_top1    = Column(Boolean)
    reranked            = Column(JSONB, nullable=False)
    flagged_concerns    = Column(JSONB)
    reasoning_summary   = Column(Text)
    s3_reasoning_full   = Column(Text)
    llm_model           = Column(String(64))
    prompt_ver          = Column(String(16))
    inference_time_ms   = Column(Integer)
    # production 추가 (v1.1 이후)
    rank_changes        = Column(JSONB)
    input_tokens        = Column(Integer)
    output_tokens       = Column(Integer)
    inference_cost_usd  = Column(Numeric)
    p3_executed_at      = Column(DateTime(timezone=True))


# ================================================================
# Phase 5 · 희귀질환 listing (LIRICAL LR)
# Composite PK (session_id, phase, executed_at) — phase=5 고정
# ================================================================
class Phase5Result(Base):
    """phase5_rare_disease_listing — phase5-lr-dev Lambda 가 INSERT (handler._insert_phase5_listing)."""
    __tablename__ = "phase5_rare_disease_listing"
    __table_args__ = {"schema": SCHEMA}

    session_id              = Column(UUID(as_uuid=True),
                                     ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                                     primary_key=True)
    phase                   = Column(Integer, primary_key=True, default=5)
    executed_at             = Column(DateTime(timezone=True), primary_key=True,
                                     default=datetime.utcnow)
    input_phase4_top_orphas = Column(ARRAY(String(32)))        # deprecated, always []
    input_hpo_used          = Column(JSONB, nullable=False)
    rare_db_ver             = Column(String(16))
    rare_db_source          = Column(String(64))
    listed_diseases         = Column(JSONB, nullable=False)
    listing_criteria        = Column(JSONB)
    total_listed_count      = Column(Integer)
    inference_time_ms       = Column(Integer)
    # production 추가 (v1.1 이후 — 002_phase5_listing_v4 migration)
    external_api_called     = Column(Boolean, default=False)
    external_api_versions   = Column(JSONB)
    top_lr_score            = Column(Numeric)
    top_lr_orphacode        = Column(String(64))
    audit_trail             = Column(JSONB)
    step0_log               = Column(JSONB)
    input_data_meta         = Column(JSONB)


# ================================================================
# Final RAG Report
# session_id + generated_at 복합 PK
# ================================================================
class FinalRagReport(Base):
    """final_report — phase5-rag-dev Lambda (rag_llm_3.py._save_to_db) 가 INSERT.

    이름이 'FinalRagReport' 인 건 frontend `sessions/{id}/result` 응답 의미를 살리기 위함.
    DB 테이블명은 final_report.
    """
    __tablename__ = "final_report"
    __table_args__ = {"schema": SCHEMA}

    session_id                = Column(UUID(as_uuid=True),
                                       ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                                       primary_key=True)
    generated_at              = Column(DateTime(timezone=True), primary_key=True,
                                       default=datetime.utcnow)
    diagnosis_json            = Column(JSONB, nullable=False)  # {final_dx, confidence, ...}
    markdown_report           = Column(Text, nullable=False)
    rag_citations             = Column(JSONB, nullable=False)
    rag_apis_used             = Column(ARRAY(String(64)))      # ["PubMed", "Orphanet", ...]
    self_check                = Column(JSONB, nullable=False)
    llm_model                 = Column(String(64))
    total_inference_time_ms   = Column(Integer)
    # PDF / HTML 메타 (rag_llm_3.py._ensure_pdf_columns() 가 동적 ALTER 추가)
    s3_uri_pdf                = Column(Text)
    s3_uri_html               = Column(Text)
    pdf_sha256                = Column(String(64))
    pdf_size_bytes            = Column(Integer)
    pdf_generated_at          = Column(DateTime(timezone=True))
    external_api_call_summary = Column(JSONB)


# ================================================================
# Physician Feedback
# ================================================================
class Feedback(Base):
    """physician_feedback — frontend /api/v1/feedback POST 가 INSERT.

    클래스명 'Feedback' 유지 (sessions.py 등 기존 import 호환). 테이블명만 physician_feedback.
    """
    __tablename__ = "physician_feedback"
    __table_args__ = {"schema": SCHEMA}

    feedback_id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id            = Column(UUID(as_uuid=True),
                                   ForeignKey(f"{SCHEMA}.diagnosis_session.session_id"),
                                   nullable=False, index=True)
    physician_id          = Column(String(64), nullable=False, index=True)
    agreed_with_top1      = Column(Boolean)
    selected_diagnosis    = Column(String(64))
    override_reason       = Column(Text)
    ui_rating             = Column(Integer)                    # 1-5
    reasoning_quality     = Column(Integer)                    # 1-5
    freeform_comment      = Column(Text)
    reviewed_at           = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    # production 추가 (v1.1 이후)
    diagnosis_code_system = Column(String(32))


# ================================================================
# Patient cache · HAPI 에서 import 한 환자 정보 보관 (FastAPI 자체 캐시)
# Production 의 patient_profile / raw_emr_bundle 과 별개. mock-emr 모드일 땐 사용 안 함.
# ================================================================
class PatientCache(Base):
    __tablename__ = "patient_cache"
    __table_args__ = {"schema": SCHEMA}

    fhir_id        = Column(String(64), primary_key=True)
    name_masked    = Column(String(64))
    sex            = Column(String(8))
    birth_date     = Column(String(16))
    cached_payload = Column(JSONB)                             # 정규화된 PatientDetail
    last_synced    = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


class FhirBundleArchive(Base):
    """원본 FHIR Bundle 보존 (감사용). Production raw_emr_bundle 과 별개."""
    __tablename__ = "fhir_bundle_archive"
    __table_args__ = {"schema": SCHEMA}

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    fhir_id     = Column(String(64), nullable=False, index=True)
    bundle      = Column(JSONB, nullable=False)
    archived_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


# ================================================================
# Audit Log (HIPAA · 의료 데이터 접근 기록) — FastAPI 자체 테이블
# Production phase_execution_log 와 별개 (그건 phase Lambda 가 기록).
# ================================================================
class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = {"schema": SCHEMA}

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clinician_id    = Column(String(64), nullable=False, index=True)
    session_id      = Column(UUID(as_uuid=True), nullable=True, index=True)
    patient_fhir_id = Column(String(64), nullable=True, index=True)
    action          = Column(String(64), nullable=False)
    payload         = Column(JSONB)
    ip_addr         = Column(String(64))
    user_agent      = Column(String(256))
    created_at      = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
