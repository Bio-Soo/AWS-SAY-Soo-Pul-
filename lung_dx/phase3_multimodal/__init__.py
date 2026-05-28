"""v2 Phase 3: Multimodal 통합 채점 (S/L/R/M 4축).

흐름:
  Phase 1 (HPO) + Phase 2 (X-ray, CheXpert 14 카테고리) + 환자 lab/micro
  → 각 modality 분석 (LabAnalyzer 단일 — v6 통합 / MicroAnalyzer /
                     SymptomMatcher / ChexpertAdapter [Option E, 2026-05-14])
  → DiagnosticScorer.score_all() — 4축 가중 합산 + threshold + bonus
  → Top N disease ranking

Option E (2026-05-14) — Phase 2 vocabulary 분담:
  Phase 2 (X-ray AI)는 CheXpert 14 카테고리 + 확률만 출력. HPO 변환 없음.
  chexpert_adapter.build_phase2_result()가 카테고리 → 영상 토큰 expansion
  적용 (data/chexpert_label_reference_v1.yaml의 의학 evidence 기반).
  HPO는 Phase 1 (증상)·Phase 5 (희귀, 별도 팀 담당)에서만 사용 — vocabulary
  granularity 비대칭을 강제 통합하지 않음.

본 Phase 3 모듈의 범위 (사용자 확정):
  - 본 Phase 3 는 multimodal scoring 만 담당
  - Phase 4 LLM re-ranking 은 별도 패키지 (phase4_llm_verify/)
  - Phase 5 rare disease 는 **별도 팀 담당** (phase5_rare/) — Phase 4 거치지 않는 독립 트랙
  - 본 Phase 3 의 산출물(Phase3Result + DiseaseScore ranking) 은 Phase 4 와 Phase 5 가
    각각 *독립적으로* 입력으로 사용. Phase 4 ↔ Phase 5 직접 의존 없음.

v6 통합 (2026-04-30): VitalsRespiratoryHemodynamicAnalyzer를 LabAnalyzer로
흡수 (lung_dx/obsoleted/vitals_analyzer.py로 이동). LabAnalyzer가 혈액·화학
+ vital + respiratory + hemodynamic + ABG + PFT 모두 처리. category 필드로
sub-grouping.

가중치 (DEFAULT_WEIGHTS):
  default: {S:0.25 L:0.20 R:0.35 M:0.20}
  rare:    {S:0.45 L:0.20 R:0.20 M:0.15}

보정 [W4]:
  W4(a) Critical Lab bonus +0.05
  W4(b) NEWS2≥7 (감염성 질환) bonus +0.03
  W4(c) Negative pathognomonic -0.10
  W4(d) 가용 모달리티 가중치 재분배
  W4(e) MIN_CRITERIA=3 정규화
  W4(f) coverage_factor = sqrt(active/patient)
  W4(g) severity weighting (critical=2.0, abnormal=1.0) — 2026-04-29 추가

이 폴더는 v1에서 phase2_multimodal로 명명되었으나, v2 컨셉(2026-04-28)에서
Phase 3로 재정의됨 (2026-04-29 폴더 rename).
"""

from .lab_analyzer import LabAnalyzer
from .micro_analyzer import MicroAnalyzer
from .symptom_matcher import SymptomMatcher
from .diagnostic_scorer import DiagnosticScorer
from .chexpert_adapter import (
    CHEXPERT_14_LABELS,
    ChexpertReferenceLoader,
    LabelExpansion,
    build_phase2_result,
    from_aurora_records,
)

__all__ = [
    "LabAnalyzer",
    "MicroAnalyzer",
    "SymptomMatcher",
    "DiagnosticScorer",
    "CHEXPERT_14_LABELS",
    "ChexpertReferenceLoader",
    "LabelExpansion",
    "build_phase2_result",
    "from_aurora_records",
]
