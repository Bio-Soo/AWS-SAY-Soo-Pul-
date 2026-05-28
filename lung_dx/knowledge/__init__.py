"""Knowledge base — v6 통합 (2026-04-30).

LabReferenceManager가 lab_reference_ranges_v9_4.yaml(134 items, 혈액·화학 +
vital + respiratory + hemodynamic + ABG + PFT 통합)을 단독 처리.
이전 VitalsRespiratoryHemodynamicManager는 lung_dx/obsoleted/로 이동.
"""
from .disease_registry import DiseaseRegistry
from .lab_reference import LabReferenceManager

__all__ = [
    "DiseaseRegistry",
    "LabReferenceManager",
]
