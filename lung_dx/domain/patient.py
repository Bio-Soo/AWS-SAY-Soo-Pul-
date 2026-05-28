"""환자 케이스 데이터 모델."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class PatientCase:
    """진단 파이프라인에 입력되는 환자 케이스 전체 데이터.

    MIMIC-IV 환자 또는 직접 입력 환자 모두 지원.
    """
    case_id: str = ""

    # ── MIMIC-IV 식별자 (선택) ────────────────────────────────
    subject_id: Optional[int] = None
    hadm_id: Optional[int] = None

    # ── 인구통계 ──────────────────────────────────────────────
    age: Optional[int] = None
    sex: Optional[str] = None  # "M" | "F"

    # ── 임상 정보 ─────────────────────────────────────────────
    chief_complaint: str = ""
    symptoms: list[str] = field(default_factory=list)          # 자유텍스트 증상명
    hpo_symptoms: list[str] = field(default_factory=list)      # HPO ID (HP:XXXXXXX)

    # ── X-ray 이미지 ──────────────────────────────────────────
    xray_image_path: Optional[str] = None

    # ── Lab 결과: [{itemid, name, value, unit, ...}] ──────────
    lab_results: list[dict[str, Any]] = field(default_factory=list)

    # ── Vitals / Respiratory / Hemodynamic ──────────────────────
    # [{itemid, name, value, unit, timestamp}]
    vitals_respiratory_hemodynamic: list[dict[str, Any]] = field(default_factory=list)

    # ── 미생물 소견 (임상의 입력 or NLP 추출) ──────────────────
    # microbiologyevents.csv 미사용 → 임상의가 직접 입력하거나
    # Excel DB의 미생물 소견과 매칭할 키워드 목록
    micro_findings: list[str] = field(default_factory=list)

    # ── 기존 유전자 검사 결과 ──────────────────────────────────
    genetic_tests: list[dict[str, Any]] = field(default_factory=list)

    # ── 추가 메모 ─────────────────────────────────────────────
    notes: str = ""
