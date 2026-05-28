"""질환 프로필 및 스코어링 결과 데이터 모델."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .enums import Confidence, DiseaseCategory


@dataclass
class DiseaseProfile:
    """528개 질환 통합 프로필.

    일반(82) + 기타(70) + 희귀(376) Excel DB와
    YAML 상세 프로필(17)을 하나의 구조체로 통합.
    """
    disease_key: str                          # 정규화된 키 (snake_case)
    name_en: str = ""                         # 영문 질병명
    name_kr: str = ""                         # 한국어 질병명
    category: DiseaseCategory = DiseaseCategory.COMMON

    # ── ICD 코드 ──────────────────────────────────────────────
    icd10_codes: list[str] = field(default_factory=list)
    icd11_code: str = ""
    icd9_code: str = ""

    # ── 진단 가중치 (S/L/R/M) ─────────────────────────────────
    weight_symptoms: float = 0.25
    weight_lab: float = 0.20
    weight_radiology: float = 0.35
    weight_micro: float = 0.20

    # ── 증상 ──────────────────────────────────────────────────
    symptoms: list[str] = field(default_factory=list)
    hpo_phenotypes: list[dict] = field(default_factory=list)
    # [{"hpo_id": "HP:0012735", "hpo_term": "Cough", "hpo_kr": "기침",
    #   "frequency": "HP:0040282"}]

    # ── Lab 패턴 ──────────────────────────────────────────────
    lab_patterns: list[str] = field(default_factory=list)
    # e.g., ["Leukocytosis", "Elevated CRP", "Hypoxemia"]

    # ── 영상 소견 ─────────────────────────────────────────────
    radiology_xray_en: str = ""       # X-ray 소견 영문
    radiology_xray_kr: str = ""       # X-ray 소견 한국어
    radiology_ct: str = ""            # CT 소견
    ai_imaging_keywords: list[str] = field(default_factory=list)
    # from "영상 키워드 (AI 매칭)" e.g., ["consolidation", "infiltrate", "opacity"]
    radiology_findings: list[str] = field(default_factory=list)
    # from YAML profiles (더 상세)
    sub_code_radiology_findings: dict[str, list[str]] = field(default_factory=dict)
    # v3_6 (2026-05-19): sub-code별 영상 hallmark 분리 (B 옵션).
    # 의학적 fact 기반 (Tschopp ERS Pneumothorax 2015 PMID 26113675 / Fleischner 2024
    # PMID 38411514 / Raghu ATS HP 2020 PMID 32706311 / BTS Bronchiectasis 2019).
    # 매칭 우선순위: sub-code 5자리 > category radiology_findings (fallback)
    # 미적용 카테고리는 빈 dict — false specificity 회피.

    # ── 미생물 소견 ───────────────────────────────────────────
    micro_findings: list[str] = field(default_factory=list)

    # ── 진단 포인트 & 참고문헌 ────────────────────────────────
    diagnostic_points: str = ""
    references: str = ""

    # ── 분류 정보 ─────────────────────────────────────────────
    classification: str = ""          # 분류/챕터

    # ── 희귀질환 전용 필드 ────────────────────────────────────
    orpha_code: Optional[str] = None
    genetic_type: Optional[str] = None    # e.g., "Autosomal dominant"
    major_genes: list[str] = field(default_factory=list)
    onset_age: Optional[str] = None
    prevalence: Optional[str] = None
    special_clinical_findings: str = ""
    prognosis_treatment: str = ""

    # ── 진단 차단 플래그 (list에는 유지, scoring에서 제외) ─────
    diagnostic_active: bool = True
    exclusion_reason: str = ""       # 차단 사유 (비전공자도 이해 가능하게)
    exclusion_category: str = ""     # non_lung_anatomical | upper_respiratory | risk_factor_only
    exclusion_reference: str = ""    # 차단 근거 레퍼런스 (PMID/URL/가이드라인)


@dataclass
class DiagnosticEvidence:
    """진단 근거 하나."""
    modality: str               # "symptoms" | "lab" | "radiology" | "micro"
    finding: str                # 환자에서 발견된 소견
    matched: bool = True        # 프로필과 매칭 여부
    profile_criterion: str = "" # 매칭 대상 프로필 기준
    weight: float = 0.0         # 모달리티 가중치
    detail: str = ""            # 추가 설명
    # v3_6 (2026-05-19): sub-code 매칭 trace (B 옵션 schema 활용 시)
    matched_sub_code: str = ""  # 매칭된 sub-code (예: "J93.11" primary spontaneous pneumothorax)
    sub_code_authority: str = ""  # sub-code 영상 fact 권위 출처 (예: "Tschopp ERS 2015 PMID:26113675")


@dataclass
class DiseaseScore:
    """질환 스코어링 결과."""
    disease_key: str
    name_en: str = ""
    name_kr: str = ""
    category: str = ""                # "common" | "other" | "rare" | "yaml"
    icd10_codes: list[str] = field(default_factory=list)

    total_score: float = 0.0          # 0.0 ~ 1.0
    confidence: Confidence = Confidence.WEAK

    modality_scores: dict[str, float] = field(default_factory=dict)
    # {"symptoms": 0.6, "lab": 0.4, "radiology": 0.8, "micro": 0.0}

    evidence: list[DiagnosticEvidence] = field(default_factory=list)
    matched_count: int = 0
    total_criteria: int = 0


# ─────────────────────────────────────────────────────────────
# Phase 5: 희귀질환 스크리닝 결과
# ─────────────────────────────────────────────────────────────
@dataclass
class RareDiseaseScore:
    """희귀질환 HPO 매칭 점수."""
    disease_key: str
    name_en: str = ""
    name_kr: str = ""
    orpha_code: str = ""
    icd10_codes: list[str] = field(default_factory=list)

    hpo_score: float = 0.0           # HPO 빈도가중 매칭 스코어
    matched_hpo: list[str] = field(default_factory=list)   # 매칭된 HPO IDs
    total_hpo: int = 0               # 해당 질환의 전체 HPO 수
    genetic_type: str = ""
    major_genes: list[str] = field(default_factory=list)


@dataclass
class GeneticTestRecommendation:
    """누락된 유전자 검사 추천."""
    gene: str                         # 유전자명
    test_type: str = ""               # "single_gene" | "gene_panel" | "WES" | "WGS"
    priority: str = "medium"          # "high" | "medium" | "low"
    associated_diseases: list[str] = field(default_factory=list)
    rationale: str = ""


@dataclass
class ConfirmatoryTest:
    """확진검사 추천."""
    test_name: str
    test_type: str = ""               # "genetic" | "lab" | "imaging" | "biopsy"
    priority: str = "medium"
    for_disease: str = ""
    rationale: str = ""


@dataclass
class Phase3Result:
    """Phase 5 희귀질환 스크리닝 결과."""
    triggered: bool = False
    trigger_reasons: list[str] = field(default_factory=list)
    rare_candidates: list[RareDiseaseScore] = field(default_factory=list)
    genetic_tests_recommended: list[GeneticTestRecommendation] = field(default_factory=list)
    confirmatory_tests: list[ConfirmatoryTest] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────
# 전체 파이프라인 결과
# ─────────────────────────────────────────────────────────────
@dataclass
class FullDiagnosticResult:
    """4단계 전체 진단 파이프라인 결과."""
    patient_case_id: str = ""
    phase1: Optional[object] = None   # Phase2Result
    phase2: Optional[object] = None   # Phase3Result
    phase3: Optional[object] = None   # Phase3Result
    report_text: str = ""             # Phase4 임상소견서
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
