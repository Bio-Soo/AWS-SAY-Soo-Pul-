"""Lab Analyzer — 통합 Lab 값 해석 + 임상 점수 + 파생 지표.

v6 통합 (2026-04-30):
  본 모듈이 *유일한* lab analyzer. v9_4 yaml(혈액·화학 + vital + respiratory +
  hemodynamic + ABG + PFT 통합 134 items)을 기반으로 모든 lab 측정값을
  단일 LabFinding으로 해석. 임상 점수(NEWS2/qSOFA/CURB-65/PESI) 및 파생
  지표(S/F ratio, P/F ratio, Driving Pressure 등)도 본 모듈이 처리.

  vitals_analyzer.py는 obsoleted — 본 모듈이 대체.

기능:
  - analyze(lab_results) — 모든 lab 측정값 해석 (혈액·화학 + vital itemid)
  - compute_scoring_systems(...) — NEWS2/qSOFA/CURB-65/PESI
  - compute_derived_indicators(...) — S/F ratio, Driving Pressure 등
  - get_abnormal_findings, extract_medical_terms, extract_disease_associations

References (점수 시스템):
  - NEWS2: Royal College of Physicians 2017
  - qSOFA: Seymour et al. JAMA 2016;315(8):762-774. PMID 26903335
  - CURB-65: Lim et al. Thorax 2003;58(5):377-382. PMID 12728155
  - PESI: Aujesky et al. Am J Respir Crit Care Med 2005;172(8):1041
"""

from __future__ import annotations

from typing import Any

from ..domain.findings import (
    DerivedIndicator,
    LabFinding,
    ScoringSystemResult,
)
from ..knowledge.lab_reference import LabReferenceManager


class LabAnalyzer:
    """환자 Lab 결과를 reference range 기반으로 해석 + 임상 점수 + 파생 지표.

    v6 통합 (2026-04-30): vitals_analyzer 흡수.
    """

    def __init__(self, lab_ref: LabReferenceManager):
        self._lab_ref = lab_ref
        self._lab_ref._ensure_loaded()

    def analyze(self, lab_results: list[dict[str, Any]]) -> list[LabFinding]:
        """환자의 Lab 결과 일괄 해석.

        v9_4 yaml에 혈액·화학 + vital itemid 모두 통합되어 있으므로 본 메서드가
        모든 lab 측정값(SpO2/HR/WBC/CRP 등)을 처리.

        Args:
            lab_results: [{itemid, name, value, unit, ref_range_lower,
                           ref_range_upper, ...}]

        Returns:
            해석된 LabFinding 목록. category 필드(blood_chem/vitals/respiratory/
            hemodynamic 등)는 lab_reference의 yaml에서 자동 부여.
        """
        findings = []
        for result in lab_results:
            itemid = result.get("itemid")
            value = result.get("value")
            if itemid is None or value is None:
                continue

            # 숫자값 해석 (vital itemid도 v9_4 yaml에 있어 동일 처리)
            if isinstance(value, (int, float)):
                finding = self._lab_ref.interpret_value(
                    itemid=itemid,
                    value=float(value),
                    ref_lower=result.get("ref_range_lower"),
                    ref_upper=result.get("ref_range_upper"),
                )
            else:
                # 정성검사 (Positive/Negative) 또는 categorical (Lung Sounds 등)
                finding = self._interpret_qualitative(itemid, str(value))

            # category 필드 자동 부여 (yaml의 category 사용)
            if not getattr(finding, "category", ""):
                item = self._lab_ref.get_item(itemid) or {}
                cat = item.get("category", "")
                # category 정규화 — yaml의 'A_Blood_Gas_Analysis' 같은 prefix 제거
                finding.category = self._normalize_category(cat)

            findings.append(finding)
        return findings

    @staticmethod
    def _normalize_category(yaml_cat: str) -> str:
        """yaml category(예: A_Blood_Gas_Analysis) → 표준 sub-group.

        sub-group: blood_chem / vitals / respiratory / hemodynamic / abg / pft / micro

        "micro" sub-group (2026-04-30 추가, v9_5 가드레일):
          yaml category "N_Infection_Microbiology" 또는 "J_Infection_Microbiology"
          (TB-PCR, IGRA, β-D-glucan, GM, PCP PCR, NTM speciation 등)는
          검사실 abnormality가 아니라 *병원체 존재의 binary positivity 지표*.
          → diagnostic_scorer._build_evidence_bundle에서 L축 lab_disease_map
            에서 제외하고 M축 micro_disease_map으로 라우팅 (이중 측정 방지).
        """
        if not yaml_cat:
            return ""
        c = yaml_cat.lower()
        # micro 분류 — N_Infection_Microbiology(v9_5) 및 J_Infection_Microbiology(v9_4 이전)
        if "infection_microbiology" in c or "microbiolog" in c:
            return "micro"
        if "blood_gas" in c or "abg" in c:
            return "abg"
        if "respiratory" in c or "pulmonary_function" in c:
            return "respiratory"
        if "vital" in c:
            return "vitals"
        if "hemodynamic" in c:
            return "hemodynamic"
        if "pulmonary_function" in c or "pft" in c:
            return "pft"
        return "blood_chem"

    # ── 임상 점수 시스템 (vitals_analyzer에서 통합 v6) ──────────
    def compute_scoring_systems(
        self,
        vital_data: list[dict[str, Any]],
        patient_age: int | None = None,
        patient_confusion: bool = False,
        patient_bun: float | None = None,
    ) -> list[ScoringSystemResult]:
        """NEWS2/qSOFA/CURB-65/PESI 임상 점수 계산.

        v6 통합: vitals_analyzer.compute_scoring_systems와 동일 로직.
        References:
          NEWS2: Royal College of Physicians 2017
          qSOFA: Seymour 2016 PMID 26903335
          CURB-65: Lim 2003 PMID 12728155
        """
        # itemid → 최신값 매핑
        vitals_map: dict[int, float] = {}
        for record in vital_data:
            itemid = record.get("itemid")
            value = record.get("value")
            if itemid is not None and isinstance(value, (int, float)):
                vitals_map[int(itemid)] = float(value)

        results = self._lab_ref.compute_scoring_systems(vitals_map)
        self._supplement_curb65(
            results, vitals_map, patient_age, patient_confusion, patient_bun
        )
        self._supplement_qsofa(results, patient_confusion)
        return results

    def compute_derived_indicators(
        self, vital_data: list[dict[str, Any]]
    ) -> list[DerivedIndicator]:
        """S/F ratio, Driving Pressure 등 파생 지표."""
        vitals_map: dict[int, float] = {}
        for record in vital_data:
            itemid = record.get("itemid")
            value = record.get("value")
            if itemid is not None and isinstance(value, (int, float)):
                vitals_map[int(itemid)] = float(value)

        indicators = self._lab_ref.compute_derived_indicators(vitals_map)

        # Driving Pressure (Pplat - PEEP) — v6 통합 추가
        pplat = vitals_map.get(224696)
        peep = vitals_map.get(220339)
        if pplat is not None and peep is not None:
            dp = pplat - peep
            cat = "target" if dp < 15 else "concern"
            indicators.append(DerivedIndicator(
                name="Driving Pressure", value=round(dp, 1),
                interpretation=f"Pplat({pplat}) - PEEP({peep})", category=cat,
            ))

        # Ventilator Dependence
        fio2 = vitals_map.get(223835, 0.21)
        peep_val = vitals_map.get(220339, 0)
        if fio2 > 0.21 or peep_val > 0:
            indicators.append(DerivedIndicator(
                name="Ventilator Dependence", value=1.0,
                interpretation=f"FiO2={fio2}, PEEP={peep_val}",
                category="ventilator_dependent",
            ))

        return indicators

    # ── CURB-65 보충 (Lim 2003 PMID 12728155) ──────────────────
    @staticmethod
    def _supplement_curb65(
        results: list[ScoringSystemResult],
        vitals_map: dict[int, float],
        age: int | None,
        confusion: bool,
        bun: float | None,
    ) -> None:
        curb = next((r for r in results if r.name == "CURB65"), None)
        if curb is None:
            curb = ScoringSystemResult(name="CURB65", score=0, components={})
            results.append(curb)
        if confusion:
            curb.components["Confusion"] = 1
            curb.score += 1
        if bun is not None and bun >= 20:
            curb.components["BUN≥20"] = 1
            curb.score += 1
        sbp = vitals_map.get(220050) or vitals_map.get(220179)
        dbp = vitals_map.get(220051) or vitals_map.get(220180)
        if sbp is not None and sbp < 90:
            curb.components["SBP<90"] = 1
            curb.score += 1
        elif dbp is not None and dbp <= 60:
            curb.components["DBP≤60"] = 1
            curb.score += 1
        if age is not None and age >= 65:
            curb.components["Age≥65"] = 1
            curb.score += 1
        if curb.score <= 1:
            curb.interpretation = "Low severity (outpatient)"
        elif curb.score == 2:
            curb.interpretation = "Moderate severity (consider admission)"
        else:
            curb.interpretation = "High severity (ICU consideration if 4-5)"

    # ── qSOFA 보충 (Seymour 2016 PMID 26903335) ─────────────────
    @staticmethod
    def _supplement_qsofa(
        results: list[ScoringSystemResult], confusion: bool
    ) -> None:
        qsofa = next((r for r in results if r.name == "qSOFA"), None)
        if qsofa is None:
            qsofa = ScoringSystemResult(name="qSOFA", score=0, components={})
            results.append(qsofa)
        if confusion:
            qsofa.components["Altered mental status"] = 1
            qsofa.score += 1
        qsofa.interpretation = (
            "Sepsis suspected" if qsofa.score >= 2 else "Low risk"
        )

    def get_abnormal_findings(
        self, findings: list[LabFinding]
    ) -> list[LabFinding]:
        """비정상 소견만 필터."""
        return [f for f in findings if f.severity != "normal"]

    def get_critical_findings(
        self, findings: list[LabFinding]
    ) -> list[LabFinding]:
        """위험(critical) 소견만 필터."""
        return [f for f in findings if f.severity == "critical"]

    def extract_medical_terms(
        self, findings: list[LabFinding]
    ) -> set[str]:
        """비정상 소견의 medical_term 집합 추출.

        diagnostic_scorer에서 질환 프로필의 lab_patterns와 매칭할 때 사용.
        예: {"Leukocytosis", "Hypoxemia", "Elevated CRP"}
        """
        terms = set()
        for f in findings:
            if f.severity != "normal" and f.medical_term:
                terms.add(f.medical_term)
        return terms

    def extract_disease_associations(
        self, findings: list[LabFinding]
    ) -> dict[str, list[str]]:
        """비정상 소견에서 disease_key → [근거 pattern] 매핑 추출.

        Returns:
            {"community_acquired_pneumonia": ["↓ pO2 (Hypoxemia)", ...]}
        """
        assoc: dict[str, list[str]] = {}
        for f in findings:
            if f.severity == "normal":
                continue
            for da in f.disease_associations:
                dk = da.get("disease_key", "")
                pattern = da.get("pattern", "")
                if dk:
                    evidence = f"{f.medical_term or f.interpretation} — {f.name}"
                    if pattern:
                        evidence += f" [{pattern[:60]}]"
                    assoc.setdefault(dk, []).append(evidence)
        return assoc

    # ── 정성검사 해석 ─────────────────────────────────────────
    def _interpret_qualitative(
        self, itemid: int | str, value: str
    ) -> LabFinding:
        """Positive/Negative, Detected/Not detected 등 정성 결과 해석."""
        item = self._lab_ref.get_item(itemid) or {}
        name = item.get("name", str(itemid))
        unit = item.get("unit", "")
        medical_terms = item.get("medical_terms", {})
        disease_assoc = item.get("disease_associations", [])

        value_lower = value.strip().lower()
        positive_keywords = {"positive", "detected", "reactive", "present"}
        negative_keywords = {"negative", "not detected", "nonreactive", "absent"}

        if any(kw in value_lower for kw in positive_keywords):
            interpretation = "Positive"
            medical_term = medical_terms.get("high", "Positive")
            severity = "abnormal"
        elif any(kw in value_lower for kw in negative_keywords):
            interpretation = "Negative"
            medical_term = ""
            severity = "normal"
        else:
            interpretation = value
            medical_term = ""
            severity = "normal"

        return LabFinding(
            itemid=itemid,
            name=name,
            value=value,
            unit=unit,
            interpretation=interpretation,
            medical_term=medical_term,
            severity=severity,
            disease_associations=disease_assoc,
            ref_source=item.get("ref_source", ""),
        )
