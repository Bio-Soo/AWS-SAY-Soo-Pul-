"""Pydantic 스키마 — Frontend ↔ FastAPI 데이터 계약.

문서: RareLink_AI_Architecture_Concepts_v1.md §5.6, §6
프론트엔드 mock (LoginWorklist.jsx 의 MOCK_PATIENTS / DEFAULT_LAB_PANELS / DEFAULT_VITALS_HISTORY /
DEFAULT_CXR_STUDIES) 와 동일한 모양 — 토글 한 번에 mock → real 전환되도록.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


# ============================================================
# 공통 enum / type aliases
# ============================================================
class SessionStatus(str, Enum):
    created = "created"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class LabFlag(str, Enum):
    high = "high"
    low = "low"
    critical = "critical"


# ============================================================
# Patient · Worklist · Demographics
# ============================================================
class DxPreview(BaseModel):
    """Top-K 후보 진단 (worklist 미리보기 용)."""
    name: str
    prob: float = Field(..., ge=0.0, le=1.0)
    rare: bool = False
    dontMiss: bool = False
    orpha: Optional[str] = Field(default=None, description="ORPHA:NNNN")


class PatientWorklistItem(BaseModel):
    """Worklist 행. /api/v1/worklist 응답 항목."""
    mrn: str
    name: str
    sex: str = Field(..., pattern=r"^[MF?]$")
    age: int
    time: str = Field(..., description="예약 시각 HH:mm (KST)")
    visit: str = Field(..., description="초진 / 재진")
    visitDate: Optional[str] = Field(default=None, description="YYYY-MM-DD")
    complaint: str = ""
    allergy: Optional[str] = None
    cxr: str = Field(default="pending", description="pending | arrived")
    status: str = Field(default="pending", description="pending | analyzing | ready")
    rare: bool = False
    dontMiss: bool = False
    acknowledged: Optional[bool] = None
    resultAt: Optional[str] = Field(default=None, description="AI 분석 완료 시각 HH:mm")
    pendingEmrUpdates: int = Field(default=0, description="EMR 미수신 건수 (배지)")
    topDx: Optional[str] = None
    preview: Optional[list[DxPreview]] = None


# ============================================================
# Lab · Vitals · Imaging — 시점별(panel) 메타데이터
# ============================================================
class LabRow(BaseModel):
    name: str
    value: str
    unit: str = ""
    range: str = ""
    flag: Optional[LabFlag] = None


class LabPanel(BaseModel):
    """검사 한 시점 분의 결과. FHIR Observation effective[x] / issued 매핑."""
    collectedAt: Optional[datetime] = Field(default=None, description="검체 채취 시각")
    resultedAt:  Optional[datetime] = Field(default=None, description="결과 보고 시각")
    rows: list[LabRow]


class LabPanelsByCategory(BaseModel):
    """카테고리별 panel 배열 (최신순). frontend 의 patient.labs 와 동일."""
    cbc:    list[LabPanel] = []
    chem:   list[LabPanel] = []
    abg:    list[LabPanel] = []
    inflam: list[LabPanel] = []


class VitalsEntry(BaseModel):
    """바이탈 한 시점."""
    measuredAt: Optional[datetime] = None
    vitals: str = Field(..., description="BP/HR/RR/SpO₂/T 한 줄 string")


class CxrStudy(BaseModel):
    """CXR study 한 건. FHIR ImagingStudy 매핑."""
    studyId: str
    capturedAt: Optional[datetime] = None
    view: str = "PA · Frontal"
    modality: str = "CR"
    imageUrl: Optional[str] = Field(
        default=None,
        description="실제 이미지 URL (cheXpert · CloudFront 라우팅). 없으면 mock SVG 렌더.",
    )


class PatientDetail(PatientWorklistItem):
    """단일 환자 상세. /api/v1/patients/{mrn} 응답."""
    vitals: Optional[str] = Field(default=None, description="legacy single-string fallback")
    vitalsHistory: list[VitalsEntry] = []
    labs: Optional[LabPanelsByCategory] = None
    cxrStudies: list[CxrStudy] = []


# ============================================================
# Diagnosis Session · Phase 1~5
# ============================================================
class SessionCreateRequest(BaseModel):
    patient_fhir_id: str = Field(..., min_length=1, max_length=64)
    symptom_text: str = Field(..., min_length=1, max_length=5000)
    cxr_s3_key: Optional[str] = None


class SessionCreateResponse(BaseModel):
    session_id: str
    status: SessionStatus = SessionStatus.created


class Phase1Result(BaseModel):
    """증상 → HPO 추출."""
    positive_hpo: list[str] = []
    negative_hpo: list[str] = []
    extracted_at: Optional[datetime] = None


class Phase2Finding(BaseModel):
    label: str
    score: float = Field(..., ge=0.0, le=1.0)
    hpo_code: Optional[str] = None    # phase2 lambda 가 라벨별 HPO 매핑 제공 시 채움


class Phase2Result(BaseModel):
    """CXR 14-label 추론."""
    findings: list[Phase2Finding] = []
    cxr_s3_key: Optional[str] = None
    inferred_at: Optional[datetime] = None


class Phase3LRScore(BaseModel):
    orpha_code: Optional[str] = None
    name: str
    name_en: Optional[str] = None
    lr_score: float


class Phase3Result(BaseModel):
    """LIRICAL LR 점수."""
    top_candidates: list[Phase3LRScore] = []
    computed_at: Optional[datetime] = None


class Phase4Verification(BaseModel):
    candidate: str
    confidence: str = Field(..., description="HIGH | MEDIUM | LOW")
    evidence: list[str] = []


class Phase4Result(BaseModel):
    """Bedrock Claude 검증."""
    verifications: list[Phase4Verification] = []
    verified_at: Optional[datetime] = None


class Phase5MatchedHPO(BaseModel):
    """phase5-lr handler 가 listed_diseases[].matched_hpo_* 안에 채우는 entry."""
    hpo_id: str
    name: str = ""
    state: str = "positive"        # positive | negative
    log_lr: float = 0.0


class Phase5Evidence(BaseModel):
    """LIRICAL LR 분해 값 — Robinson 2020 Fig.2 막대 시각화 근거."""
    log_lr_radiology: float = 0.0
    log_lr_symptoms:  float = 0.0
    log_lr_lab:       float = 0.0
    log_lr_micro:     float = 0.0
    weighted_log_lr:  float = 0.0
    log_prior:        float = 0.0
    final_score:      float = 0.0


class RareDiseaseListing(BaseModel):
    """phase5-lr handler 출력 listed_diseases[] 의 단일 entry."""
    orphacode:           str
    disease_en:          str = ""
    disease_kr:          str = ""
    icd10:               list[str] = []
    lr_value:            float
    lr_category:         Optional[str] = None    # A~G (LR_pipeline_v2.docx)
    matched_hpo_phase1:  list[Phase5MatchedHPO] = []
    matched_hpo_phase2:  list[Phase5MatchedHPO] = []
    matched_hpo_lab:     list[Phase5MatchedHPO] = []
    contradicted_hpo:    list[Phase5MatchedHPO] = []
    weights_applied:     dict[str, float] = Field(default_factory=dict)
    evidence:            Optional[Phase5Evidence] = None
    prevalence:          str = ""
    prevalence_numeric:  float = 0.0
    gene_associations:   list[str] = []
    inheritance:         list[str] = []


class Phase5Result(BaseModel):
    """LIRICAL LR 기반 희귀질환 listing.

    Source: phase5-lr-dev Lambda → phase5_rare_disease_listing 테이블.
    Frontend PHASE_DEFS[4] (희귀 listing) 와 매핑.
    """
    listed_diseases:    list[RareDiseaseListing] = []
    total_listed_count: int = 0
    top_lr_score:       Optional[float] = None
    top_lr_orphacode:   Optional[str]   = None
    listing_criteria:   dict[str, Any]  = Field(default_factory=dict)   # threshold_lr / sort / engine
    rare_db_version:    Optional[str]   = None
    executed_at:        Optional[datetime] = None


class SessionDetailResponse(BaseModel):
    """세션 상태 + Phase 결과 (Frontend 가 2초마다 polling)."""
    session_id: str
    patient_fhir_id: str
    status: SessionStatus
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    phase1: Optional[Phase1Result] = None
    phase2: Optional[Phase2Result] = None
    phase3: Optional[Phase3Result] = None
    phase4: Optional[Phase4Result] = None
    phase5: Optional[Phase5Result] = None
    created_at: datetime
    updated_at: datetime


class RagCitation(BaseModel):
    """RAG 인용 — Phase5 RAG (phase5-rag-dev) 가 final_report 에 INSERT.

    rag_llm_3.py 의 실제 출력 형식 (disease 별 한 묶음, free-text summary):
      { "disease_id", "disease_name",
        "pubmed_cases", "pubmed_guide", "clinical_trials",
        + (있을 때) "orphanet", "monarch", "pubcasefinder" 등 }

    또한 legacy / future 형식 (per-source 한 줄 인용) 도 흡수 가능하도록 모든 필드 Optional +
    extra='allow' — backend 가 깨지지 않고 frontend 가 가진 필드만 활용.
    """
    model_config = ConfigDict(extra='allow')

    # Aurora 의 phase5-rag-dev (rag_llm_3.py) 출력 형식 — 질환 1건 묶음
    disease_id:      Optional[str] = None
    disease_name:    Optional[str] = None
    pubmed_cases:    Optional[str] = None
    pubmed_guide:    Optional[str] = None
    clinical_trials: Optional[str] = None
    orphanet:        Optional[str] = None
    monarch:         Optional[str] = None
    pubcasefinder:   Optional[str] = None

    # Legacy / per-source 한 줄 인용 (future RAG handler 호환)
    title:     Optional[str]   = None
    source:    Optional[str]   = None
    url:       Optional[str]   = None
    pmid:      Optional[str]   = None
    relevance: Optional[float] = None


class SessionFinalReport(BaseModel):
    """최종 통합 리포트. /api/v1/sessions/{id}/result.

    Source: phase5-rag-dev Lambda → final_report 테이블.
    Frontend PHASE_DEFS[5] (RAG 리포트) 와 매핑.
    """
    session_id:      str
    patient_fhir_id: str
    final_dx:        Optional[str]            = None
    confidence:      Optional[str]            = None
    diagnosis_json:  dict[str, Any]           = Field(default_factory=dict)
    markdown_report: str                      = ""
    full_report_md:  str                      = ""              # backwards-compat alias
    rag_citations:   list[RagCitation]        = []
    rag_apis_used:   list[str]                = []              # ["PubMed", "Orphanet", ...]
    self_check:      Optional[dict[str, Any]] = None            # {pmid_total, pmid_valid, pmid_rate}
    llm_model:       Optional[str]            = None
    s3_uri_pdf:      Optional[str]            = None
    generated_at:    datetime


# ============================================================
# Feedback · Audit
# ============================================================
class FeedbackCreate(BaseModel):
    session_id: str
    final_dx_correct: bool
    correction: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=2000)


# ============================================================
# Worklist · Daily preload
# ============================================================
class WorklistResponse(BaseModel):
    date: str
    count: int
    patients: list[PatientWorklistItem]


# ============================================================
# EMR Updates · WebSocket payloads (보충 — frontend 배지)
# ============================================================
class EmrUpdateDelta(BaseModel):
    resource: str
    category: str
    count: int


class EmrUpdateMessage(BaseModel):
    type: str = "emr-update"
    mrn: str
    pendingDelta: int
    delta: list[EmrUpdateDelta]
    since: datetime
    now: datetime
