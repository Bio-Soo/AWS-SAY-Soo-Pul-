"""Lab Reference 매니저 — lab_reference_ranges_v9_4.yaml 기반 (통합).

v6 통합 (2026-04-30):
  v9_4 yaml은 134 검사항목 — 혈액·화학 + vital + respiratory + hemodynamic +
  ABG + PFT 모두 포함 (top-level itemid keys: 220277=SpO2, 220045=HR 등).
  본 모듈이 *유일한* lab reference manager. vitals_reference.py는 obsoleted.

기능:
  - interpret_value(itemid, value) — 모든 lab 측정값 해석 (vital 포함)
  - compute_scoring_systems(vitals_map) — NEWS2/qSOFA 등 임상 점수
  - compute_derived_indicators(vitals_map) — S/F ratio 등 파생 지표
  - 정상범위, thresholds, medical_terms, disease_associations, hpo_terms 관리
"""

from __future__ import annotations

import re
from typing import Any, Optional

import yaml

from ..config import paths
from ..domain.findings import (
    DerivedIndicator,
    LabFinding,
    ScoringSystemResult,
)


class LabReferenceManager:
    """lab_reference_ranges_v3.yaml 로드 및 검사값 해석."""

    def __init__(self, yaml_path: str | None = None):
        self._yaml_path = yaml_path or str(paths.LAB_REFERENCE_YAML)
        self._items: dict[str | int, dict[str, Any]] = {}
        self._loaded = False

    # ── 로드 ──────────────────────────────────────────────────
    def load(self) -> None:
        with open(self._yaml_path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)
        for key, item in raw.items():
            self._items[key] = item
        self._loaded = True

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self.load()

    # ── 조회 ──────────────────────────────────────────────────
    @property
    def item_count(self) -> int:
        self._ensure_loaded()
        return len(self._items)

    def get_all_itemids(self) -> list[str | int]:
        self._ensure_loaded()
        return list(self._items.keys())

    def get_mimic_itemids(self) -> list[int]:
        """MIMIC-IV 내장 ItemID만 반환 (숫자)."""
        self._ensure_loaded()
        return [k for k in self._items if isinstance(k, int)]

    def get_item(self, itemid: int | str) -> dict[str, Any] | None:
        self._ensure_loaded()
        return self._items.get(itemid)

    def get_items_by_category(self, category: str) -> list[tuple[str | int, dict]]:
        """카테고리별 항목 조회. e.g., 'A_Blood_Gas_Analysis'."""
        self._ensure_loaded()
        return [
            (k, v) for k, v in self._items.items()
            if v.get("category", "") == category
        ]

    # ── 검사값 해석 ───────────────────────────────────────────
    def interpret_value(
        self,
        itemid: int | str,
        value: float,
        ref_lower: Optional[float] = None,
        ref_upper: Optional[float] = None,
    ) -> LabFinding:
        """검사값을 reference range와 비교하여 해석.

        우선순위:
        1. 외부 제공 ref_lower/ref_upper (MIMIC labevents)
        2. YAML ranges
        """
        self._ensure_loaded()
        item = self._items.get(itemid, {})
        name = item.get("name", str(itemid))
        unit = item.get("unit", "")
        ref_source = item.get("ref_source", "")
        medical_terms = item.get("medical_terms", {})
        disease_assoc = item.get("disease_associations", [])

        # Reference range 결정
        yaml_ranges = item.get("ranges", {})
        lower = ref_lower if ref_lower is not None else yaml_ranges.get("lower")
        upper = ref_upper if ref_upper is not None else yaml_ranges.get("upper")

        # 해석 (2026-04-29 수정: critical dict → thresholds list parsing)
        # 출처: lab_reference_ranges_v9_4.yaml은 thresholds list 사용 (critical 필드 부재).
        # 이전 코드는 critical dict 읽으려다 None 받아 severity='critical' 판정 실패.
        # vitals_reference.py와 동일 패턴 적용.
        interpretation = "Normal"
        medical_term = ""
        severity = "normal"

        # 1단계: ranges 비교 → abnormal/normal 판정
        if lower is not None and value < lower:
            interpretation = "Low"
            medical_term = medical_terms.get("low", "")
            severity = "abnormal"
        elif upper is not None and value > upper:
            interpretation = "High"
            medical_term = medical_terms.get("high", "")
            severity = "abnormal"

        # 2단계: thresholds list 검색하여 critical 판정
        # 키워드 set (의학 표준 정의):
        # - low side: severe/critical/ltot/failure (심한 저하)
        # - high side: severe/critical/shock/septic/crisis/dka (심한 상승)
        # - 제외: target/normal/borderline (정상 범위 또는 경계)
        # - 제외: life_threatening_<condition>_* (조건부 — 일반 환자에게 직접 적용 X)
        thresholds_list = item.get("thresholds", [])

        def _is_critical_threshold(th_name_lower: str, direction: str) -> bool:
            # 정상/경계 threshold 제외
            if any(kw in th_name_lower for kw in ["target", "borderline", "normal_"]):
                return False
            # 조건부 threshold 제외 (life_threatening_asthma_* 등)
            if "life_threatening_" in th_name_lower and "_" in th_name_lower.replace("life_threatening_", ""):
                # life_threatening_asthma → 조건부
                # life_threatening (단독) → critical
                rest = th_name_lower.replace("life_threatening_", "").rstrip("_")
                if any(c in rest for c in ["asthma_", "copd_", "_bradycardia", "_tachycardia"]):
                    return False
            # critical 키워드 — 방향 무관 트리거
            critical_keywords_any = ["severe", "critical", "septic_shock", "shock"]
            # 방향별 추가 키워드
            low_kws = ["ltot", "hypoglycemic_coma", "respiratory_failure"]
            high_kws = ["dka", "hypertensive_crisis", "ph_crisis"]
            if any(kw in th_name_lower for kw in critical_keywords_any):
                return True
            if direction == "low" and any(kw in th_name_lower for kw in low_kws):
                return True
            if direction == "high" and any(kw in th_name_lower for kw in high_kws):
                return True
            return False

        if interpretation == "Low" and "critical_low" in medical_terms:
            # 가장 'least restrictive' critical threshold 찾기 (highest value)
            best_threshold = None
            for th in thresholds_list:
                th_name = th.get("name", "").lower()
                if not _is_critical_threshold(th_name, "low"):
                    continue
                # low 방향 키워드 추가 검증 (false positive 차단)
                if not any(d in th_name for d in ["low", "hypo", "brady", "ltot", "failure", "depression", "asphyxia"]):
                    continue
                th_val = self._parse_threshold_value(th.get("criterion", ""))
                if th_val is not None and value <= th_val:
                    if best_threshold is None or th_val > best_threshold:
                        best_threshold = th_val
            if best_threshold is not None:
                interpretation = "Critical Low"
                medical_term = medical_terms.get("critical_low", medical_term)
                severity = "critical"

        if interpretation == "High" and "critical_high" in medical_terms:
            best_threshold = None
            for th in thresholds_list:
                th_name = th.get("name", "").lower()
                if not _is_critical_threshold(th_name, "high"):
                    continue
                if not any(d in th_name for d in ["high", "hyper", "tachy", "crisis", "shock", "septic", "dka"]):
                    continue
                th_val = self._parse_threshold_value(th.get("criterion", ""))
                if th_val is not None and value >= th_val:
                    if best_threshold is None or th_val < best_threshold:
                        best_threshold = th_val
            if best_threshold is not None:
                interpretation = "Critical High"
                medical_term = medical_terms.get("critical_high", medical_term)
                severity = "critical"

        return LabFinding(
            itemid=itemid,
            name=name,
            value=value,
            unit=unit,
            ref_lower=lower,
            ref_upper=upper,
            interpretation=interpretation,
            medical_term=medical_term,
            severity=severity,
            disease_associations=disease_assoc,
            ref_source=ref_source,
        )

    def get_disease_associations(self, itemid: int | str) -> list[dict]:
        self._ensure_loaded()
        item = self._items.get(itemid, {})
        return item.get("disease_associations", [])

    # ── 임상 점수 시스템 (NEWS2/qSOFA/CURB-65/PESI) ───────────
    # v6 통합 (2026-04-30): vitals_reference.py에서 통합. v9_4 yaml에
    # scoring_systems 필드가 vital itemid 항목에 있음.
    def compute_scoring_systems(
        self, vitals: dict[int, float]
    ) -> list[ScoringSystemResult]:
        """이용 가능한 측정값으로 NEWS2, qSOFA 등 계산."""
        self._ensure_loaded()
        system_totals: dict[str, dict] = {}

        for itemid, value in vitals.items():
            item = self._items.get(itemid, {})
            for sys_name, rules in item.get("scoring_systems", {}).items():
                score = self._evaluate_scoring(value, rules)
                if score is not None:
                    if sys_name not in system_totals:
                        system_totals[sys_name] = {"score": 0, "components": {}}
                    system_totals[sys_name]["score"] += score
                    system_totals[sys_name]["components"][item.get("name", str(itemid))] = score

        results = []
        for sys_name, data in system_totals.items():
            results.append(ScoringSystemResult(
                name=sys_name,
                score=data["score"],
                interpretation=self._interpret_system_score(sys_name, data["score"]),
                components=data["components"],
            ))
        return results

    # ── 파생 지표 (S/F ratio, P/F ratio, Driving Pressure 등) ──
    def compute_derived_indicators(
        self, vitals: dict[int, float]
    ) -> list[DerivedIndicator]:
        """S/F ratio 등 파생 지표 계산."""
        self._ensure_loaded()
        results = []

        for itemid, item in self._items.items():
            for di in item.get("derived_indicators", []):
                name = di.get("name", "")
                if name == "S/F ratio" and 220277 in vitals and 223835 in vitals:
                    spo2 = vitals[220277]
                    fio2 = vitals[223835]
                    if fio2 > 0:
                        sf_ratio = spo2 / fio2
                        cat = self._classify_sf_ratio(sf_ratio)
                        results.append(DerivedIndicator(
                            name="S/F ratio",
                            value=round(sf_ratio, 1),
                            interpretation=f"SpO2({spo2})/FiO2({fio2})",
                            category=cat,
                        ))
        return results

    # ── 내부 유틸 (vitals_reference.py에서 통합) ───────────────
    @staticmethod
    def _parse_threshold_value(criterion: str) -> float | None:
        """'≤94', '<90', '≥96' 등에서 숫자 추출."""
        m = re.search(r"[<≤>≥]?\s*([\d.]+)", criterion)
        return float(m.group(1)) if m else None

    @staticmethod
    def _check_threshold(value: float, criterion: str) -> bool:
        criterion = criterion.strip()
        range_match = re.match(r"([\d.]+)[–-]([\d.]+)", criterion)
        if range_match:
            lo, hi = float(range_match.group(1)), float(range_match.group(2))
            return lo <= value <= hi
        for op, fn in [
            ("≤", lambda v, t: v <= t),
            ("≥", lambda v, t: v >= t),
            ("<", lambda v, t: v < t),
            (">", lambda v, t: v > t),
        ]:
            if criterion.startswith(op):
                num = re.search(r"[\d.]+", criterion[len(op):])
                if num:
                    return fn(value, float(num.group()))
        return False

    def _evaluate_scoring(self, value: float, rules: dict) -> float | None:
        for criterion_str, score in rules.items():
            if self._check_threshold(value, str(criterion_str)):
                return self._parse_score_value(score)
        return None

    @staticmethod
    def _parse_score_value(score: Any) -> float:
        if isinstance(score, (int, float)):
            return float(score)
        s = str(score).strip()
        m = re.search(r"[+-]?\d+\.?\d*", s)
        return float(m.group()) if m else 0.0

    @staticmethod
    def _interpret_system_score(system: str, score: int | float) -> str:
        if system.startswith("NEWS2"):
            if score >= 7:
                return "High clinical risk"
            elif score >= 5:
                return "Medium clinical risk"
            elif score >= 1:
                return "Low clinical risk"
            return "No risk"
        if system == "qSOFA":
            return "Sepsis suspected" if score >= 2 else "Low risk"
        return ""

    @staticmethod
    def _classify_sf_ratio(sf: float) -> str:
        if sf <= 148:
            return "severe_ards"
        elif sf <= 235:
            return "moderate_ards"
        elif sf <= 315:
            return "mild_ards"
        return "normal"
