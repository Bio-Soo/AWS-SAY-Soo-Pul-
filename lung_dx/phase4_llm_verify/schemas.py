"""Phase 4 입출력 schema 정의.

원칙: 모든 disease/HP/citation 항목은 권위 출처 검증 통과 필수.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


# ── Citation (모든 진단/권고에 필수) ──────────────────────────
@dataclass
class Citation:
    """권위 출처 인용. PMID/ISBN/가이드라인 + 연도 필수."""
    type: Literal['PMID','ISBN','guideline','PMC','DOI']
    identifier: str       # 예: 'PMID:31573350' or 'GOLD 2026 Ch.5'
    year: int | None      # 발행연도 (가이드라인 최신성 검증)
    section: str | None   # 챕터/표/섹션 (예: 'Ch.69', 'Table 2.4')
    title: str | None     # 출처 제목 (예: 'ATS/IDSA CAP Guidelines')


# ── Phase 4 입력 ──────────────────────────────────────────────
@dataclass
class Phase4Input:
    """Phase 4 입력 = Phase 3 결과 + 환자 임상 정보."""
    # Phase 3 ranking
    phase3_ranking: list[dict]   # [{disease_key, score, hp_matches, ...}, ...]
    # 매칭 HP IDs (Phase 1 → Phase 3 누적)
    matched_hp_ids: list[str]
    # 환자 임상 정보 (Phase 4가 종합 추론하는 데 필요)
    patient_age: int | None = None
    patient_sex: Literal['M','F','unknown'] = 'unknown'
    patient_history: list[str] = field(default_factory=list)  # ['COPD 10y', '알콜중독']
    patient_medications: list[str] = field(default_factory=list)  # ['prednisone 10mg']
    # Phase 2 영상 소견 (선택)
    xray_findings: list[str] = field(default_factory=list)  # ['우하엽 consolidation']
    # 검사 결과 요약
    lab_summary: list[dict] = field(default_factory=list)
    # NEWS2/CURB-65 등 임상 점수
    clinical_scores: dict = field(default_factory=dict)


# ── Phase 4 출력 (Guard Rail 통과 후) ──────────────────────────
@dataclass
class RevisedDiseaseRanking:
    """LLM 검증 후 재 ranking 단일 항목."""
    rank: int
    disease_key: str
    score: float                # 0.0 ~ 1.0
    rank_change: int            # 변경 (+5, -2 등)
    rationale: str              # 변경/유지 사유 (의학 추론)
    citations: list[Citation]   # 권고 근거 (1+ 필수)


@dataclass
class MissedDiagnosisAlert:
    """누락 진단 alert."""
    disease_or_condition: str
    rationale: str
    recommended_workup: list[str]   # ['BAL', '(1,3)-β-D-glucan', 'IGRA']
    citations: list[Citation]


@dataclass
class GuardRailReport:
    """Guard Rail 6종 적용 리포트 (audit trail)."""
    hp_id_validation_passed: bool
    icd_mapping_validation_passed: bool
    citation_required_passed: bool
    confidence_threshold_passed: bool
    hallucination_keyword_passed: bool
    schema_validation_passed: bool
    rejected_items: list[dict] = field(default_factory=list)


@dataclass
class Phase4Result:
    """Phase 4 최종 결과."""
    revised_ranking: list[RevisedDiseaseRanking]
    missed_alerts: list[MissedDiagnosisAlert]
    overall_confidence: float
    guard_rail_report: GuardRailReport
    raw_llm_response: str
    parse_success: bool
    fallback_to_phase3: bool   # Guard Rail 실패 시 True
    mode: Literal['mock','real'] = 'mock'
