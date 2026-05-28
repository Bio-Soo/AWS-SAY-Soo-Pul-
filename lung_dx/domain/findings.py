"""개별 검사 소견 데이터 모델."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ─────────────────────────────────────────────────────────────
# Phase 2: 영상학적 소견 (X-ray AI)
# ─────────────────────────────────────────────────────────────
# Owner 의 5-phase 파이프라인 정의 (2026-05-18 확정):
#   Phase 1 = symptom (증상·문진, HPO)
#   Phase 2 = X-ray AI (CheXpert 14 라벨)            ← 본 섹션
#   Phase 3 = multimodal scoring (symptoms + x-ray + lab + micro 통합)
#   Phase 4 = LLM re-ranking
#   Phase 5 = rare disease (LIRICAL)
@dataclass
class XrayPrediction:
    """CheXNet 모델 출력 — CheXpert label 하나의 확률."""
    label: str              # CheXpert label (e.g., "Consolidation")
    probability: float      # 0.0 ~ 1.0


@dataclass
class RadiologyFinding:
    """X-ray에서 발견된 영상학적 소견 하나."""
    finding: str                    # e.g., "consolidation"
    present: bool = True            # True=확인, False=의심(possible)
    probability: float = 0.0       # CheXNet 확률
    ai_keywords: list[str] = field(default_factory=list)  # 매칭된 AI 키워드
    location: Optional[str] = None  # e.g., "left lower lobe"
    icd10_codes: list[str] = field(default_factory=list)  # 연관 ICD-10


@dataclass
class Phase2Result:
    """Phase 2 X-ray 분석 결과 (CheXpert 14 라벨 + DB 토큰 expansion)."""
    detected_findings: list[RadiologyFinding] = field(default_factory=list)   # prob >= threshold
    possible_findings: list[RadiologyFinding] = field(default_factory=list)   # possible 범위
    all_predictions: list[XrayPrediction] = field(default_factory=list)       # 전체 14개 label
    candidate_icd_codes: list[str] = field(default_factory=list)
    ai_keywords_matched: list[str] = field(default_factory=list)
    gradcam_paths: dict[str, str] = field(default_factory=dict)  # label → 히트맵 경로


# ─────────────────────────────────────────────────────────────
# Phase 3: multimodal scoring (symptoms + x-ray + lab + micro 통합)
#   본 섹션은 Phase 3 로 입력되는 4 modality 소견 자료형들 정의
#   (LabFinding/MicroFinding/SymptomMatch + scoring 보조 자료형).
#   Phase 2 의 X-ray 결과(Phase2Result)는 별도 정의되어 있고
#   Phase 3 의 통합 결과는 Phase3Result 에 모임.
# ─────────────────────────────────────────────────────────────
#
# 데이터 모델 통합 (2026-04-30 후반):
#   메모리 project_2026-04-15_unified_reference.md 정합 — lab v6에서
#   137 items / 18 cat 통합 (혈액·화학 lab + vitals + respiratory +
#   hemodynamic + micro context). 그러나 *Python dataclass 통합은
#   누락된 업데이트*였음 — v4 보고서에서 "itemid 체계 다르기 때문"
#   으로 정당화한 것은 사견·거짓이었음 (사용자 audit으로 적발).
#
# 본 통합:
#   - LabFinding을 확장해 VRHFinding의 모든 필드 흡수
#     (name_kr, thresholds_triggered, scoring_contributions, hpo_id, category)
#   - VitalsRespiratoryHemodynamicFinding은 LabFinding의 alias로 유지
#     (backward compat — 기존 import/isinstance 모두 작동)
#   - 새 필드 category로 sub-class 구분 ("blood_chem"/"vitals"/
#     "respiratory"/"hemodynamic")
@dataclass
class LabFinding:
    """통합 Lab finding — 혈액·화학 lab + vitals + respiratory + hemodynamic.

    출처: lab_reference_ranges_v9_4.yaml (137 items, 18 cat) 통합 정합.
    이전 VitalsRespiratoryHemodynamicFinding은 본 클래스의 alias (deprecated).

    필드:
      itemid/name/value/unit/severity 등 — 모든 측정값에 공통
      hpo_id — Phase 5 HPO Aggregator가 사용 (severity≥abnormal에서 매핑)
      category — sub-grouping ("blood_chem" / "vitals" / "respiratory" /
                "hemodynamic" / "abg" / "pft" 등)
      thresholds_triggered/scoring_contributions — VRH에서 흡수
        (NEWS2/CURB-65/qSOFA 점수 시스템 정합)
    """
    itemid: int | str               # MIMIC ItemID 또는 EXT_XX
    name: str                       # 검사·측정명 (e.g., "pO2", "SpO2")
    value: float | str = 0.0        # 실측값
    unit: str = ""
    ref_lower: Optional[float] = None
    ref_upper: Optional[float] = None
    interpretation: str = ""        # "Low", "High", "Normal", "Critical"
    medical_term: str = ""          # "Hypoxemia", "Leukocytosis" 등
    severity: str = "normal"        # normal / abnormal / critical / borderline
    disease_associations: list[dict] = field(default_factory=list)
    ref_source: str = ""

    # ── VRH 통합 흡수 필드 (2026-04-30) ─────────────────────────
    name_kr: str = ""               # 한국어 명칭 (e.g., "산소포화도")
    thresholds_triggered: list[str] = field(default_factory=list)
    scoring_contributions: dict[str, int | float] = field(default_factory=dict)
    # ── Phase 5 HPO 매핑 (lab_reference_ranges_v9_4.yaml hpo_terms) ──
    hpo_id: str = ""
    # ── 카테고리 (sub-grouping for analysis) ─────────────────────
    # "blood_chem" / "vitals" / "respiratory" / "hemodynamic" / "abg" / "pft" / etc.
    category: str = ""


# ── Backward compat alias (deprecated 2026-04-30, 점진 마이그레이션) ──
# 기존 import: `from ..domain.findings import VitalsRespiratoryHemodynamicFinding`
# 모두 LabFinding을 가리키게 됨. isinstance 체크 통일됨.
VitalsRespiratoryHemodynamicFinding = LabFinding


@dataclass
class MicroFinding:
    """미생물 소견 (Excel DB 매칭 기반, CSV 미사용)."""
    organism: str                   # 균종명
    matched_diseases: list[str] = field(default_factory=list)  # 매칭된 질환 키


@dataclass
class SymptomMatch:
    """환자 증상과 질환 프로필 간 매칭 결과."""
    symptom: str                    # 증상명
    hpo_id: str = ""                # HPO ID
    hpo_kr: str = ""                # 한국어 증상명
    frequency: str = ""             # "common", "frequent", "occasional" 또는 HPO 빈도코드
    matched_diseases: list[str] = field(default_factory=list)


@dataclass
class ScoringSystemResult:
    """임상 스코어링 시스템 계산 결과."""
    name: str                       # "NEWS2", "qSOFA", "CURB-65", "PESI"
    score: int | float = 0
    interpretation: str = ""        # e.g., "High risk"
    components: dict[str, int | float] = field(default_factory=dict)


@dataclass
class DerivedIndicator:
    """파생 지표 (S/F ratio, P/F ratio 등)."""
    name: str
    value: float = 0.0
    interpretation: str = ""
    category: str = ""              # e.g., "mild_ards", "moderate_ards"


@dataclass
class Phase3Result:
    """Phase 3 다중모달 매칭 결과 (symptoms + x-ray + lab + micro 통합 scoring).

    v6 (2026-04-30) 표기 통일:
      lab_findings — Phase 3 L축 단일 list (LabFinding 인스턴스).
        혈액·화학 + vital + respiratory + hemodynamic + ABG + PFT 모두 포함.
        category 필드(blood_chem/vitals/respiratory/hemodynamic/abg/pft 등)로
        sub-grouping.
      vrh_findings 필드 제거 — 활성 코드에서 vrh 표기 폐기
        (feedback_lab_unified_naming.md 정합).
    """
    lab_findings: list[LabFinding] = field(default_factory=list)
    micro_findings: list[MicroFinding] = field(default_factory=list)
    symptom_matches: list[SymptomMatch] = field(default_factory=list)
    scoring_systems: list[ScoringSystemResult] = field(default_factory=list)
    derived_indicators: list[DerivedIndicator] = field(default_factory=list)
    ranked_diseases: list = field(default_factory=list)  # List[DiseaseScore]
    top_candidates: list = field(default_factory=list)   # List[DiseaseScore]
