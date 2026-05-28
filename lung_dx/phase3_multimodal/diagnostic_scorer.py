"""가중 다중모달 질환 스코어링 엔진.

528개 질환에 대해 환자의 Lab, Vitals/Respiratory/Hemodynamic, Microbiology,
Symptoms(HPO) 소견을 질환별 S/L/R/M 가중치로 종합 평가하여
가능성이 높은 질환을 순위대로 산출한다.

# ═══════════════════════════════════════════════════════════════
# 가중치 체계 및 부여 근거 (Fact-Based)
# ═══════════════════════════════════════════════════════════════
#
# [W1] 가중치의 의미
#
#   S (Symptoms):   임상 증상·병력·신체 소견의 진단 기여도
#   L (Lab):        검사실 검사(혈액가스, CBC, 생화학 등)의 진단 기여도
#   R (Radiology):  영상검사(X-ray, CT 등)의 진단 기여도
#   M (Micro):      미생물학적 검사(배양, PCR, 항원 등)의 진단 기여도
#
#   모든 가중치의 합은 1.0이다: S + L + R + M = 1.0
#   높은 가중치 = 해당 모달리티가 진단에 더 결정적인 역할을 함.
#
# [W2] 명시적 가중치가 있는 질환 (58개)
#
#   YAML 17개 질환: lung_disease_profiles_v2.yaml에 기재된 weights.
#     근거: Harrison's 21st Ed, Mandell's 9th Ed, UpToDate 2025,
#     GOLD 2024, GINA 2024, ESC PE 2019, ESC/ERS PH 2022, ATS/ERS IPF 2022.
#     각 질환의 진단 알고리즘에서 모달리티의 상대적 중요도를 반영.
#
#   Excel 일반 21개 + 기타 20개: "진단 가중치 (S/L/R/M)" 컬럼.
#     근거: 동일 가이드라인 기반으로 구축.
#
#   이 질환들은 해당 값을 그대로 사용한다.
#
# [W3] 기본 가중치 — 명시적 가중치가 없는 질환 (478개)
#
#   명시적 가중치가 없는 질환은 질환 유형(category)에 따라
#   임상적으로 적절한 기본 가중치를 적용한다.
#
#   기본 가중치 도출 근거:
#
#   (a) 전체 기본값: S:0.25  L:0.20  R:0.35  M:0.20
#       → YAML 17개 질환의 가중 평균에서 도출:
#         S=0.244, L=0.228, R=0.364, M=0.165
#       → 폐질환에서 영상검사(CXR/CT)가 진단의 핵심 수단이라는
#         임상 현실을 반영. ATS/IDSA CAP 2019, GOLD 2024, ESC PE 2019
#         등 주요 가이드라인 모두 영상검사를 진단 알고리즘의 초기 단계에 배치.
#       [Harrison's 21st Ch.33 "Approach to Chest Imaging";
#        ATS/IDSA CAP 2019 Fig.1 "Diagnostic Algorithm"]
#
#   (b) 희귀질환 기본값: S:0.45  L:0.20  R:0.20  M:0.15
#       → 희귀질환은 Excel Sheet 3(영상·Lab·Micro) 데이터가 대부분 부재하고,
#         Sheet 2(HPO 표현형)에 3,468개 레코드가 수록되어 있어
#         표현형(증상) 매칭이 1차 스크리닝의 핵심 수단이다.
#       → Orphanet/HPO 기반 희귀질환 진단 접근법:
#         "표현형 유사도(phenotypic similarity) 기반 후보 질환 도출 →
#          확진검사(유전자·생검 등)로 확정"
#         [Köhler et al. Am J Hum Genet 2009;84(4):457-467
#          — HPO-based phenotype matching for rare disease diagnosis;
#          Orphanet — "phenotype-driven approach to rare diseases"]
#       → Lab·Radiology·Micro 가중치는 데이터 가용성에 비례하여 낮춤.
#
# [W4] 보정 계수(Adjustments) 및 근거
#
#   (a) Critical Lab Value 보너스: +0.05
#       근거: Critical value("panic value")는 즉각적 의료 개입이 필요한
#       수치로, 해당 질환과의 연관성이 매우 높다.
#       [CAP Critical Values Checklist; Tietz 7th Ch.5]
#
#   (b) Clinical Scoring 보너스: NEWS2 ≥7이고 감염성 질환이면 +0.03
#       근거: NEWS2 ≥7은 "High clinical risk"로 응급 대응이 필요한 수준.
#       급성 감염 질환(폐렴, 패혈증)에서 NEWS2 고점수는 진단 확신도를
#       높이는 보조 근거가 된다.
#       [Royal College of Physicians. NEWS2, 2017]
#
#   (c) 음성 소견 감점: 병리특이소견이 명시적으로 음성이면 -0.10/건
#       근거: 해당 질환에서 반드시 나타나야 하는 소견(pathognomonic
#       finding)이 없으면 해당 질환의 가능성을 유의하게 낮춘다.
#       예: 기흉에서 X-ray 기흉 소견 음성 → 기흉 가능성 대폭 감소.
#       [Harrison's 21st — 각 질환의 "Diagnostic Criteria" 섹션]
#
#   (d) 가용 모달리티 재분배
#       특정 모달리티의 데이터가 전혀 없거나 해당 질환 프로필에
#       해당 모달리티 criteria가 없으면, 그 가중치를 나머지 모달리티에
#       비례 배분한다.
#       이유: 데이터 부재로 인한 불공정한 점수 하락을 방지.
#       예: 미생물 검사 미시행 환자 → M 가중치를 S/L/R에 재분배.
#
# [W6] 미생물 검사 가드레일 (이중 측정 방지, 2026-04-30 옵션 C)
#
#   v9_5 yaml에 추가된 24개 N_Infection_Microbiology 항목
#   (β-D-glucan, GM serum/BAL, PCP/Flu/RSV PCR, Mycoplasma/Chlamydophila IgM,
#    Cryptococcal Ag, NTM speciation, Aspergillus IgG, TB-PCR, IGRA 등)은
#   *검사실 abnormal severity*가 아니라 *병원체 존재의 binary positivity 지표*.
#
#   임계값 의미 (예시):
#     - CRP 100 mg/L → 검사실 abnormal severity (염증 정도) → L축
#     - β-D-glucan ≥80 pg/mL → invasive fungal infection 양성 → M축
#     - GM serum ≥0.5 → invasive aspergillosis 양성 → M축
#     - PCP PCR positive → Pneumocystis jirovecii 검출 → M축
#
#   가드레일 강제 [_build_evidence_bundle]:
#     1) lab_disease_map(L축)에서 category="micro" 검사 *제외*.
#     2) micro_disease_map(M축)으로 라우팅 (medical_term을 organism으로).
#     3) lab_terms 집합에서도 제외 (텍스트 매칭 이중 카운트 방지).
#     4) has_lab_data는 non-micro lab만 카운트, has_micro_data는 micro lab도 인정.
#
#   [근거] Patterson IDSA Aspergillosis 2016 PMID:27365388 §VI,
#          Maschmeyer ECIL PCP 2016 PMID:27550993 — micro biomarker는
#          fungal/infection diagnostic axis로 분류, lab severity로 다루지 않음.
#
# [W5] 참고문헌
#
#   [1] Harrison's Principles of Internal Medicine, 21st Ed (2022)
#   [2] Mandell, Douglas, and Bennett's Principles and Practice of Infectious Diseases, 9th Ed (2019)
#   [3] ATS/IDSA. Diagnosis and Treatment of CAP. AJRCCM 2019
#   [4] GOLD 2024 — Global Strategy for COPD
#   [5] GINA 2024 — Global Initiative for Asthma
#   [6] ESC Guidelines for PE (2019; Eur Heart J 2020;41(4):543-603) / ESC/ERS PH (2022; Eur Heart J 2022;43(38):3618-3731)
#   [7] ATS/ERS IPF Guidelines (2022)
#   [8] Berlin Definition for ARDS. JAMA 2012
#   [9] Royal College of Physicians. NEWS2, 2017
#   [10] Köhler et al. Clinical diagnostics in HPO. AJHG 2009
#   [11] Orphanet — phenotype-driven rare disease diagnosis approach
#   [12] CAP (College of American Pathologists) Critical Values Checklist
#   [13] Tietz Textbook of Laboratory Medicine, 7th Ed (Rifai N, Elsevier 2023)
#   [14] UpToDate 2025 — disease-specific diagnostic algorithms
# ═══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import re
from typing import Optional

from ..domain.disease import (
    DiseaseProfile,
    DiseaseScore,
    DiagnosticEvidence,
)
from ..domain.enums import Confidence, DiseaseCategory
from ..domain.findings import (
    LabFinding,
    MicroFinding,
    SymptomMatch,
    ScoringSystemResult,
    Phase2Result,
)
from ..knowledge.disease_registry import DiseaseRegistry


# ── 기본 가중치 [W3] ─────────────────────────────────────────
# 명시적 가중치가 없는 질환에 적용하는 카테고리별 기본값.

DEFAULT_WEIGHTS = {
    # 전체 기본값 — YAML 17개 질환 가중 평균 기반 [W3(a)]
    "default": {"symptoms": 0.25, "lab": 0.20, "radiology": 0.35, "micro": 0.20},
    # 희귀질환 — HPO 표현형 중심 [W3(b)]
    "rare":    {"symptoms": 0.45, "lab": 0.20, "radiology": 0.20, "micro": 0.15},
}

# ── 보정 상수 [W4] ────────────────────────────────────────────
CRITICAL_LAB_BONUS = 0.05     # [W4(a)]
NEWS2_HIGH_BONUS = 0.03       # [W4(b)]
NEGATIVE_PATHOGNOMONIC = -0.10 # [W4(c)]

# ── Severity weight [W4(g)] (2026-04-29 추가) ─────────────────
# Critical lab/vital findings는 abnormal 보다 진단적 중요도가 더 큼.
# 예: SpO2 88% (critical) vs 92% (abnormal) — 임상적 의미 다름.
# 표준 임상 점수 시스템 정합:
#   - NEWS2 (Royal College of Physicians 2017): SpO2 ≤91% = 3pt vs 92-93% = 2pt vs 94-95% = 1pt → 비율 ~2:1
#   - CURB-65 등은 binary (critical 만 점수) but 본 시스템은 연속 score
# 채택: critical = 2.0, abnormal = 1.0 (NEWS2 가중치 정합)
SEVERITY_WEIGHT = {"critical": 2.0, "abnormal": 1.0}

# ── 최소 기준 수 정규화 [W4(e)] ───────────────────────────────
# 기준 항목이 1~2개뿐인 질환이 우연 매칭으로 ratio=1.0을 받아
# 과대평가되는 것을 방지한다.
# 각 모달리티에서 최소 이 수 이상의 기준이 있어야 ratio=1.0이 가능.
# 예: Lab 기준 1개 질환은 1/max(1,3)=0.33, 4개 매칭/7개 기준은 4/7=0.57
# → 구체적 프로필(CAP)이 모호한 프로필보다 높게 평가된다.
# [Harrison's 21st — 진단 알고리즘은 다중 소견의 종합을 요구;
#  Bayesian diagnostic reasoning: more evidence = higher confidence]
MINIMUM_CRITERIA_PER_MODALITY = 3

# ── 다중모달 근거 커버리지 [W4(f)] ────────────────────────────
# 하나의 모달리티에서만 근거가 있는 질환은 진단 확신도가 낮다.
# 여러 모달리티(증상+Lab+영상+미생물)에서 동시에 근거가 있을수록
# 진단의 신뢰도가 높아진다 (Bayesian diagnostic convergence).
# coverage_factor = sqrt(active_modalities / patient_available_modalities)
# [Harrison's 21st Ch.1 "The Practice of Medicine" — 진단은 다중
#  소견의 수렴(convergence of evidence)으로 확립됨;
#  Sox et al. Medical Decision Making, 2nd Ed — 독립 소견의
#  조합은 우도비(likelihood ratio)를 기하급수적으로 증가시킴]

# ── 감염 관련 질환 YAML 키 (NEWS2 보너스 적용 대상) ──────────
# 런타임에 registry.yaml_key_map으로 실제 키를 resolve하여 사용.
_INFECTIOUS_YAML_KEYS = {
    "community_acquired_pneumonia", "hospital_acquired_pneumonia",
    "aspiration_pneumonia", "lung_abscess", "tuberculosis",
    "viral_pneumonia", "influenza", "empyema",
    "acute_bronchitis", "acute_bronchiolitis",
}


class DiagnosticScorer:
    """528개 질환 가중 다중모달 스코어링 엔진."""

    def __init__(self, disease_registry: DiseaseRegistry):
        self._registry = disease_registry
        self._registry._ensure_loaded()

    def score_all(
        self,
        patient_lab_findings: list[LabFinding],
        patient_micro_findings: Optional[list[MicroFinding]] = None,
        patient_symptom_matches: Optional[list[SymptomMatch]] = None,
        phase2_result: Optional[Phase2Result] = None,
        scoring_results: Optional[list[ScoringSystemResult]] = None,
        top_n: int = 10,
        include_rare: bool = False,
    ) -> list[DiseaseScore]:
        """전체 질환에 대해 스코어링 수행.

        v6 통합 (2026-04-30): patient_lab_findings 단일 인자에 혈액·화학 +
        vital + respiratory + hemodynamic + ABG + PFT 모두 포함 (LabFinding
        instance, category 필드로 sub-grouping). 별도 vrh 인자 제거.

        Args:
            patient_lab_findings: 모든 lab 측정값 통합 list
            patient_micro_findings: 미생물 매칭 결과
            patient_symptom_matches: 증상 매칭 결과
            phase2_result: Phase 2 X-ray 분석 결과 (선택)
            scoring_results: NEWS2/qSOFA 등 스코어링 결과 (선택)
            top_n: 상위 N개 반환
            include_rare: 희귀질환 포함 여부

        Returns:
            DiseaseScore 목록 (score 내림차순).
        """
        patient_micro_findings = patient_micro_findings or []
        patient_symptom_matches = patient_symptom_matches or []

        # v6: lab_findings 단일 list로 처리. _build_evidence_bundle은
        # 두 인자 받는 기존 시그니처 호환 — 두번째 빈 list 전달.
        evidence_bundle = self._build_evidence_bundle(
            patient_lab_findings, [],
            patient_micro_findings, patient_symptom_matches,
            phase2_result,
        )

        # NEWS2 점수 확인
        news2_score = 0
        if scoring_results:
            for sr in scoring_results:
                if sr.name.startswith("NEWS2") and not sr.name.endswith("COPD"):
                    news2_score = sr.score

        # 감염성 질환 키 세트 (YAML key → 실제 profile key resolve)
        key_map = self._registry.yaml_key_map
        infectious_keys = set()
        for yk in _INFECTIOUS_YAML_KEYS:
            infectious_keys.add(key_map.get(yk, yk))

        # 전체 질환 스코어링
        scores = []
        for profile in self._registry.get_all():
            if not include_rare and profile.category == DiseaseCategory.RARE:
                continue
            # 진단 차단 profile 건너뛰기 (list에는 존재하나 scoring 대상 아님)
            # 사유: 비-폐질환(심장/혈관/뇌) 또는 상기도(인두/후두) 또는 위험인자
            if not profile.diagnostic_active:
                continue

            score = self._score_single_disease(
                profile, evidence_bundle, news2_score, infectious_keys
            )
            scores.append(score)

        # 정렬 및 반환
        scores.sort(key=lambda s: s.total_score, reverse=True)
        return scores[:top_n]

    def _build_evidence_bundle(
        self,
        lab_findings: list[LabFinding],
        vrh_findings: list[LabFinding],
        micro_findings: list[MicroFinding],
        symptom_matches: list[SymptomMatch],
        phase1: Optional[Phase2Result],
    ) -> dict:
        """환자 소견을 스코어링에 적합한 형태로 정리.

        ── 미생물 검사 가드레일 [W6] (2026-04-30, v9_5 옵션 C) ──
        lab_findings에 v9_5 신규 micro 항목(β-D-glucan, GM, PCP/Flu/RSV PCR,
        Mycoplasma/Chlamydophila IgM, Cryptococcal Ag, NTM speciation, Asp IgG
        등 24건; category="micro")이 포함될 수 있다. 이들 검사의 임계값은
        검사실 abnormality(예: CRP 등급)이 아니라 *특정 병원체 존재의 binary
        positivity 지표*이다 (예: β-D-glucan ≥80 pg/mL = invasive fungal
        infection 증거). 따라서 다음 가드레일을 강제한다:

        1) lab_disease_map (L축)에서 category="micro" 검사를 *제외* —
           검사실 severity로 카운트되면 안 됨.
        2) micro_disease_map (M축)으로 라우팅 — 각 양성 micro 검사를
           pseudo-organism(medical_term 또는 name)으로 추가하여
           profile.micro_findings 매칭과 동일한 효과.

        [근거] 이중 측정(double-counting) 방지: 한 환자의 β-D-glucan 양성이
        L축과 M축에 동시에 가산되면 score가 인위적으로 부풀려진다.
        Aspergillosis IDSA 2016, ECIL PCP 2016 모두 micro biomarker를
        "fungal/infection diagnostic axis"로만 분류 — 검사실 일반 abnormal로
        다루지 않음. [Patterson PMID 27365388, Maschmeyer PMID 27550993]
        """
        # Lab medical terms 집합 — micro 카테고리 제외 (L축은 비-micro만)
        lab_terms = set()
        has_critical_lab = False
        for f in lab_findings:
            if getattr(f, "category", "") == "micro":
                continue
            if f.severity != "normal" and f.medical_term:
                lab_terms.add(f.medical_term.lower())
            if f.severity == "critical":
                has_critical_lab = True

        # YAML key → profile key 매핑 (disease_associations의 키 변환)
        key_map = self._registry.yaml_key_map

        # Lab disease associations (YAML key를 실제 profile key로 변환)
        # [2026-04-29] severity-aware: critical/abnormal 분리 카운트
        # [2026-04-30 v9_5 가드레일] category="micro"는 L축 제외 — M축 라우팅
        lab_disease_map: dict[str, dict[str, int]] = {}
        micro_lab_findings: list[LabFinding] = []  # M축 라우팅 대상
        for f in lab_findings:
            if f.severity == "normal":
                continue
            # ── 가드레일 [W6]: micro 카테고리는 L축 제외 ─────────
            if getattr(f, "category", "") == "micro":
                micro_lab_findings.append(f)
                continue
            sev_key = f.severity if f.severity in SEVERITY_WEIGHT else "abnormal"
            for da in f.disease_associations:
                dk = da.get("disease_key", "")
                if dk:
                    resolved = key_map.get(dk, dk)
                    if resolved not in lab_disease_map:
                        lab_disease_map[resolved] = {"critical": 0, "abnormal": 0}
                    lab_disease_map[resolved][sev_key] += 1

        # VRH disease associations (severity-aware)
        vrh_disease_map: dict[str, dict[str, int]] = {}
        for f in vrh_findings:
            if f.severity == "normal":
                continue
            sev_key = f.severity if f.severity in SEVERITY_WEIGHT else "abnormal"
            for da in f.disease_associations:
                dk = da.get("disease_key", "")
                if dk:
                    resolved = key_map.get(dk, dk)
                    if resolved not in vrh_disease_map:
                        vrh_disease_map[resolved] = {"critical": 0, "abnormal": 0}
                    vrh_disease_map[resolved][sev_key] += 1

        # Micro disease → [organisms]
        # 1) MicroAnalyzer가 생성한 MicroFinding (배양/PCR 등 임상의 입력)
        # 2) [가드레일 W6] lab_findings 중 category="micro" 양성 검사
        #    (β-D-glucan ≥80, GM ≥0.5, PCP PCR positive 등)
        micro_disease_map: dict[str, list[str]] = {}
        for f in micro_findings:
            for dk in f.matched_diseases:
                micro_disease_map.setdefault(dk, []).append(f.organism)
        # micro lab findings → M축 라우팅
        for f in micro_lab_findings:
            organism = f.medical_term or f.name or str(f.itemid)
            for da in f.disease_associations:
                dk = da.get("disease_key", "")
                if dk:
                    resolved = key_map.get(dk, dk)
                    micro_disease_map.setdefault(resolved, []).append(organism)

        # Symptom disease → [symptoms]
        symptom_disease_map: dict[str, list[str]] = {}
        for m in symptom_matches:
            for dk in m.matched_diseases:
                symptom_disease_map.setdefault(dk, []).append(m.symptom)

        # Phase 1 AI keywords
        ai_keywords = set()
        if phase1:
            ai_keywords = {kw.lower() for kw in phase1.ai_keywords_matched}

        # has_lab_data — non-micro lab finding이 1건 이상 존재해야 True
        # has_micro_data — MicroFinding 또는 micro lab finding 중 어느 한 쪽이
        #   존재하면 True (가드레일 W6: micro lab도 M축에 가용 데이터로 인정)
        non_micro_lab_count = sum(
            1 for f in lab_findings if getattr(f, "category", "") != "micro"
        )

        # v3_6 (2026-05-19): Phase 2 candidate_icd_codes — sub_code_radiology_findings
        # 매칭에 사용. Phase 2 X-ray AI가 출력한 ICD 후보 list (Phase2Result.candidate_icd_codes).
        # 의학적 fact 근거: Tschopp ERS 2015 / Fleischner 2024 / Raghu HP 2020 등.
        candidate_icd_codes = list(getattr(phase1, "candidate_icd_codes", []) or []) if phase1 else []

        return {
            "lab_terms": lab_terms,
            "has_critical_lab": has_critical_lab,
            "lab_disease_map": lab_disease_map,
            "vrh_disease_map": vrh_disease_map,
            "micro_disease_map": micro_disease_map,
            "symptom_disease_map": symptom_disease_map,
            "ai_keywords": ai_keywords,
            "candidate_icd_codes": candidate_icd_codes,
            # 환자 데이터 가용성 (모달리티별 재분배 판단용) [W4(d)]
            "has_lab_data": non_micro_lab_count > 0,
            "has_radiology_data": bool(ai_keywords),
            "has_micro_data": len(micro_findings) > 0 or len(micro_lab_findings) > 0,
            "has_symptom_data": len(symptom_matches) > 0,
        }

    def _score_single_disease(
        self,
        profile: DiseaseProfile,
        evidence: dict,
        news2_score: int,
        infectious_keys: set[str] | None = None,
    ) -> DiseaseScore:
        """단일 질환의 스코어 계산.

        알고리즘:
        1. 4개 모달리티별 match_ratio 계산 (0.0~1.0)
        2. 질환별 S/L/R/M 가중치로 가중 합산
        3. 보정 적용 [W4]
        4. Confidence 분류
        """
        # ── 1) 가중치 결정 ────────────────────────────────────
        weights = self._get_weights(profile)

        # ── 2) 모달리티별 매칭 비율 ──────────────────────────
        evidences = []

        # (S) Symptoms
        ratio_s, evid_s = self._calc_symptom_ratio(profile, evidence)

        # (L) Lab
        ratio_l, evid_l = self._calc_lab_ratio(profile, evidence)

        # (R) Radiology
        ratio_r, evid_r = self._calc_radiology_ratio(profile, evidence)

        # (M) Micro
        ratio_m, evid_m = self._calc_micro_ratio(profile, evidence)

        evidences = evid_s + evid_l + evid_r + evid_m

        # ── 3) 가중 합산 (데이터 없는 모달리티 재분배) [W4(d)] ─
        #
        # 재분배 조건: 환자에게 해당 모달리티의 데이터가 전혀 없으면
        # 그 모달리티의 가중치를 제외한다.
        # 예: X-ray 미촬영 시 R 가중치를 S/L/M에 비례 재분배.
        patient_has_data = {
            "symptoms": evidence["has_symptom_data"],
            "lab": evidence["has_lab_data"],
            "radiology": evidence["has_radiology_data"],
            "micro": evidence["has_micro_data"],
        }

        symptom_criteria = len(profile.symptoms) or len(profile.hpo_phenotypes)
        modality_data = [
            ("symptoms", ratio_s, weights["symptoms"], symptom_criteria),
            ("lab", ratio_l, weights["lab"], len(profile.lab_patterns)),
            ("radiology", ratio_r, weights["radiology"],
             len(profile.ai_imaging_keywords) + len(profile.radiology_findings)),
            ("micro", ratio_m, weights["micro"], len(profile.micro_findings)),
        ]

        numerator = 0.0
        denominator = 0.0
        modality_scores = {}

        for mod_name, ratio, weight, criteria_count in modality_data:
            modality_scores[mod_name] = round(ratio, 3)
            # 환자에게 데이터가 있고, 프로필에 기준이 있는 경우만 포함
            if criteria_count > 0 and patient_has_data.get(mod_name, True):
                numerator += weight * ratio
                denominator += weight

        base_score = numerator / denominator if denominator > 0 else 0.0

        # ── 다중모달 근거 커버리지 보정 [W4(f)] ──────────────
        # 프로필에 기준이 있는 모달리티 수 / 환자에게 데이터가 있는 모달리티 수
        import math
        active_modalities = sum(
            1 for mod_name, ratio, weight, cc in modality_data
            if cc > 0 and patient_has_data.get(mod_name, True) and ratio > 0
        )
        patient_modalities = sum(
            1 for mod_name in patient_has_data
            if patient_has_data.get(mod_name, False)
        )
        if patient_modalities > 0 and active_modalities > 0:
            coverage_factor = math.sqrt(active_modalities / patient_modalities)
        else:
            coverage_factor = 0.0
        base_score *= coverage_factor

        # ── 4) 보정 [W4] ─────────────────────────────────────
        adjustments = 0.0

        # [W4(a)] Critical Lab
        if evidence["has_critical_lab"]:
            dk = profile.disease_key
            if dk in evidence["lab_disease_map"]:
                adjustments += CRITICAL_LAB_BONUS

        # [W4(b)] NEWS2 High + 감염성 질환
        if news2_score >= 7 and infectious_keys and profile.disease_key in infectious_keys:
            adjustments += NEWS2_HIGH_BONUS

        final_score = max(0.0, min(1.0, base_score + adjustments))

        # ── 5) Confidence ─────────────────────────────────────
        if final_score > 0.7:
            confidence = Confidence.STRONG
        elif final_score >= 0.4:
            confidence = Confidence.MODERATE
        else:
            confidence = Confidence.WEAK

        matched_count = sum(
            1 for e in evidences if e.matched
        )
        total_criteria = sum(
            c for _, _, _, c in modality_data
        )

        return DiseaseScore(
            disease_key=profile.disease_key,
            name_en=profile.name_en,
            name_kr=profile.name_kr,
            category=profile.category.value,
            icd10_codes=profile.icd10_codes,
            total_score=round(final_score, 4),
            confidence=confidence,
            modality_scores=modality_scores,
            evidence=evidences,
            matched_count=matched_count,
            total_criteria=total_criteria,
        )

    # ── 가중치 결정 ───────────────────────────────────────────
    def _get_weights(self, profile: DiseaseProfile) -> dict[str, float]:
        """질환 프로필에서 가중치 추출. 없으면 기본값 적용 [W2][W3]."""
        s = profile.weight_symptoms
        l = profile.weight_lab
        r = profile.weight_radiology
        m = profile.weight_micro

        total = s + l + r + m

        # 가중치가 명시적으로 설정된 경우 (합 ~1.0)
        if 0.95 <= total <= 1.05:
            return {"symptoms": s, "lab": l, "radiology": r, "micro": m}

        # 기본값 적용
        if profile.category == DiseaseCategory.RARE:
            return DEFAULT_WEIGHTS["rare"]
        return DEFAULT_WEIGHTS["default"]

    # ── 모달리티별 매칭 비율 계산 ─────────────────────────────
    def _calc_symptom_ratio(
        self, profile: DiseaseProfile, evidence: dict
    ) -> tuple[float, list[DiagnosticEvidence]]:
        """증상 매칭 비율.

        분모는 profile.symptoms(핵심 임상 증상 목록)만 사용한다.
        hpo_phenotypes는 "가능한 모든 표현형"의 전수 목록이므로
        Phase 3 다중모달 진단 스코어링의 분모에는 포함하지 않는다.
        HPO 전수 매칭은 Phase 5 희귀질환 스크리닝에서 수행한다
        (Phase 5 는 별도 팀 담당이며 본 Phase 3 scorer 와 독립).
        [Harrison's 21st — 진단 알고리즘은 핵심 증상(cardinal symptoms)
         기반이며, 가능한 모든 표현형의 완전 충족을 요구하지 않음]
        """
        disease_symptoms = evidence["symptom_disease_map"].get(
            profile.disease_key, []
        )
        # 핵심 증상만 분모로 사용
        total = len(profile.symptoms)
        if total == 0:
            # 증상 리스트 없으면 HPO 수로 fallback (희귀질환 등)
            total = len(profile.hpo_phenotypes)
        if total == 0:
            return 0.0, []

        matched = len(disease_symptoms)
        # 최소 기준 수 정규화 [W4(e)]
        effective_total = max(total, MINIMUM_CRITERIA_PER_MODALITY)
        ratio = min(matched / effective_total, 1.0)

        evidences = [
            DiagnosticEvidence(
                modality="symptoms",
                finding=s,
                matched=True,
                profile_criterion="symptom match",
                weight=0.0,
            )
            for s in disease_symptoms
        ]
        return ratio, evidences

    def _calc_lab_ratio(
        self, profile: DiseaseProfile, evidence: dict
    ) -> tuple[float, list[DiagnosticEvidence]]:
        """Lab 매칭 비율.

        두 가지 소스에서 매칭:
        1. lab_terms vs profile.lab_patterns (텍스트 매칭)
        2. lab_disease_map에서 해당 질환의 직접 association 수
        """
        patient_terms = evidence["lab_terms"]
        profile_patterns = profile.lab_patterns
        # [2026-04-29] severity-weighted direct_hits
        # critical lab finding은 abnormal보다 2배 가중치 (NEWS2 정합)
        sev_counts = evidence["lab_disease_map"].get(profile.disease_key, {"critical": 0, "abnormal": 0})
        if isinstance(sev_counts, int):  # backcompat — pre-2026-04-29 schema
            direct_hits = sev_counts
        else:
            direct_hits = (sev_counts["critical"] * SEVERITY_WEIGHT["critical"]
                           + sev_counts["abnormal"] * SEVERITY_WEIGHT["abnormal"])

        if not profile_patterns and direct_hits == 0:
            return 0.0, []

        # 텍스트 패턴 매칭 — 핵심 용어(core term) 기반
        # "Elevated CRP (inflammation)"의 핵심: "elevated crp"
        # "Markedly Elevated CRP (severe inflammation/infection)"의 핵심: "markedly elevated crp"
        # → "elevated crp" ⊂ "markedly elevated crp" → 매칭 성공
        text_matched = 0
        evidences = []
        for pattern in profile_patterns:
            pattern_lower = pattern.strip().lower()
            pattern_core = re.sub(r"\s*\(.*?\)", "", pattern_lower).strip()

            matched_flag = False
            for pt in patient_terms:
                pt_core = re.sub(r"\s*\(.*?\)", "", pt).strip()
                # 전체 매칭 또는 핵심 용어 매칭
                if (pattern_lower in pt or pt in pattern_lower
                        or pattern_core in pt_core or pt_core in pattern_core):
                    matched_flag = True
                    break

            if matched_flag:
                text_matched += 1
                evidences.append(DiagnosticEvidence(
                    modality="lab",
                    finding=pattern,
                    matched=True,
                    profile_criterion=pattern,
                ))

        # 직접 association 매칭 (YAML disease_associations)
        # — 텍스트 매칭과 중복 방지 위해 max 사용
        total_criteria = max(len(profile_patterns), 1)
        total_matched = max(text_matched, direct_hits)

        # Blended scoring (v2 — clinical saturation + coverage)
        # ─────────────────────────────────────────────────────────
        # 문제: 기존 `total_matched / len(profile_patterns)` 방식은
        #       lab_patterns가 많은 profile(예: CAP 7개)을 불리하게 함.
        #       CAP(4/7=0.57) vs 만성기관지염(4/4=1.00) — 임상적 역전.
        # 해결: coverage(정밀도) + saturation(임상적 충분성) 평균 채택.
        #   · coverage: matched / len(profile_patterns) — 얼마나 profile을 설명?
        #   · saturation: min(matched / MIN_CRITERIA, 1.0) — 임상적 충분 match 수?
        #     (ATS/IDSA CAP 2025 등 다수 가이드라인이 "≥2-3 criteria" 패턴
        #      충족 시 진단 근거로 인정하는 임상관행 반영)
        # 결과: CAP 4/7 → (0.57 + 1.00)/2 = 0.78 상승
        coverage = total_matched / max(total_criteria, 1)
        saturation = min(total_matched / MINIMUM_CRITERIA_PER_MODALITY, 1.0)
        ratio = min((coverage + saturation) / 2, 1.0)
        return ratio, evidences

    def _calc_radiology_ratio(
        self, profile: DiseaseProfile, evidence: dict
    ) -> tuple[float, list[DiagnosticEvidence]]:
        """영상 키워드 매칭 비율.

        Phase 2 X-ray AI keywords + VRH disease associations 활용.
        """
        ai_keywords = evidence["ai_keywords"]

        # 프로필의 AI 키워드
        profile_keywords = {kw.lower() for kw in profile.ai_imaging_keywords}
        # YAML radiology_findings도 포함 (카테고리 단위)
        profile_keywords.update(kw.lower() for kw in profile.radiology_findings)
        # v3_6 (2026-05-19): sub_code_radiology_findings — sub-code별 specific 토큰
        # 의학적 fact 기반 (Tschopp ERS 2015 PMID:26113675 / Fleischner 2024 PMID:38411514 /
        # Raghu HP 2020 PMID:32706311 / Lewinsohn TB 2017 PMID:27932390 / Scadding 1958).
        # 매칭 전략: Phase 2 candidate_icd_codes (evidence) 우선, profile.icd10_codes fallback.
        # 미매핑 sub-code는 카테고리 단위 radiology_findings로 fallback (이미 위 line).
        sub_code_rad = getattr(profile, "sub_code_radiology_findings", {}) or {}
        # sub_code_keyword_to_icd: 어떤 토큰이 어떤 sub-code 매칭으로 추가됐는지 추적 (evidence trace용)
        sub_code_keyword_to_icd: dict[str, str] = {}
        if sub_code_rad:
            # Phase 2 출력의 candidate_icd_codes (evidence) 우선
            phase2_icds = evidence.get("candidate_icd_codes", []) or []
            # profile.icd10_codes(list)에 속하는 phase 2 ICD만 매칭
            profile_icds = set(getattr(profile, "icd10_codes", []) or [])
            matched_sub_icds = [i for i in phase2_icds if i in profile_icds and i in sub_code_rad]
            if not matched_sub_icds:
                # Phase 2 매칭 없으면 profile 의 모든 sub-code 토큰 추가 (category-equivalent fallback)
                matched_sub_icds = [i for i in profile_icds if i in sub_code_rad]
            for icd in matched_sub_icds:
                for kw in sub_code_rad[icd]:
                    kw_lower = kw.lower()
                    profile_keywords.add(kw_lower)
                    # evidence trace: 첫 매칭 sub-code 기록 (중복 sub-code 매칭 시 첫번째 우선)
                    sub_code_keyword_to_icd.setdefault(kw_lower, icd)

        if not profile_keywords:
            # VRH disease_map에서의 매칭으로 대체 (severity-weighted)
            sev_counts = evidence["vrh_disease_map"].get(profile.disease_key, {"critical": 0, "abnormal": 0})
            if isinstance(sev_counts, int):  # backcompat
                vrh_hits = sev_counts
            else:
                vrh_hits = (sev_counts["critical"] * SEVERITY_WEIGHT["critical"]
                            + sev_counts["abnormal"] * SEVERITY_WEIGHT["abnormal"])
            if vrh_hits > 0:
                return min(vrh_hits / 3, 1.0), []
            return 0.0, []

        matched = profile_keywords & ai_keywords
        # 최소 기준 수 정규화 [W4(e)]
        effective_total = max(len(profile_keywords), MINIMUM_CRITERIA_PER_MODALITY)
        ratio = len(matched) / effective_total if effective_total else 0.0

        # v3_6 (2026-05-19): sub-code 매칭 evidence trace 명시 (B 옵션 활용 시)
        # 매칭된 토큰이 sub_code_radiology_findings에서 왔으면 sub-code + authority 기록
        # 권위 출처 매핑 (의학적 fact 기반)
        SUB_CODE_AUTHORITY = {
            'J93.0': 'BTS MacDuff 2010 PMID:20696690 (tension pneumothorax)',
            'J93.11': 'Tschopp ERS 2015 PMID:26113675 (primary spontaneous pneumothorax)',
            'J93.12': 'Tschopp ERS 2015 PMID:26113675 (secondary spontaneous pneumothorax)',
            'J43.0': 'Fleischner 2024 PMID:38411514 (MacLeod/Swyer-James)',
            'J43.1': 'Fleischner 2024 PMID:38411514 (panlobular emphysema)',
            'J43.2': 'Fleischner 2024 PMID:38411514 (centrilobular emphysema)',
            'J96.01': 'Berlin ARDS 2012 (Type I hypoxic respiratory failure)',
            'J96.02': 'ATS/ERS NIV 2017 (Type II hypercapnic respiratory failure)',
            'A15.0': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390',
            'A15.5': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390 (tracheobronchial)',
            'A15.6': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390 (tuberculous pleurisy)',
            'A15.7': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390 (primary respiratory TB Ghon)',
            'A15.8': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390 (miliary)',
            'A16.5': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390',
            'A16.7': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390',
            'A16.8': 'Lewinsohn ATS/CDC/IDSA TB 2017 PMID:27932390',
            'C34.0': 'NCCN NSCLC 2024 (main bronchus)',
            'C34.1': 'NCCN NSCLC 2024 (Pancoast/superior sulcus)',
            'C34.2': 'NCCN NSCLC 2024 (middle lobe)',
            'C34.3': 'NCCN NSCLC 2024 (lower lobe)',
            'D86.0': 'Scadding 1958 standard (Sarcoidosis stage 3-4)',
            'D86.1': 'Scadding 1958 standard (Sarcoidosis stage 1 BHL)',
            'D86.2': 'Scadding 1958 standard (Sarcoidosis stage 2)',
            'J84.112': 'Raghu IPF 2022 PMC9851481 (IPF UIP pattern)',
            'J84.10': 'Raghu IPF 2022 (NSIP pattern)',
            'J84.17': 'organizing pneumonia pattern',
            'J47.0': 'BTS Bronchiectasis 2019 PMID:30545985 (with acute LRI)',
            'J47.1': 'BTS Bronchiectasis 2019 PMID:30545985 (with exacerbation)',
            'J47.9': 'BTS Bronchiectasis 2019 PMID:30545985 (uncomplicated)',
            'I26.02': 'ESC PE 2019 PMID:31473594 (saddle PE)',
            'I26.09': 'ESC PE 2019 PMID:31473594 (acute PE with cor pulm)',
            'I26.90': 'ESC PE 2019 PMID:31473594 (acute PE without cor pulm)',
            'I26.92': 'ESC PE 2019 PMID:31473594 (saddle PE without cor pulm)',
            'J81.0': 'Gluecker 1999 PMID:10555672 (acute pulmonary edema)',
            'I50.1': 'cardiogenic pulmonary edema',
        }
        evidences = []
        for kw in matched:
            sub_icd = sub_code_keyword_to_icd.get(kw, "")
            evidences.append(DiagnosticEvidence(
                modality="radiology",
                finding=kw,
                matched=True,
                profile_criterion=("AI keyword match (sub-code specific)" if sub_icd
                                   else "AI keyword match"),
                matched_sub_code=sub_icd,
                sub_code_authority=SUB_CODE_AUTHORITY.get(sub_icd, "") if sub_icd else "",
            ))
        return min(ratio, 1.0), evidences

    def _calc_micro_ratio(
        self, profile: DiseaseProfile, evidence: dict
    ) -> tuple[float, list[DiagnosticEvidence]]:
        """미생물 매칭 비율."""
        matched_organisms = evidence["micro_disease_map"].get(
            profile.disease_key, []
        )
        total = len(profile.micro_findings)
        if total == 0:
            return 0.0, []

        # 최소 기준 수 정규화 [W4(e)]
        effective_total = max(total, MINIMUM_CRITERIA_PER_MODALITY)
        ratio = min(len(matched_organisms) / effective_total, 1.0)
        evidences = [
            DiagnosticEvidence(
                modality="micro",
                finding=org,
                matched=True,
                profile_criterion="organism match",
            )
            for org in matched_organisms
        ]
        return ratio, evidences
