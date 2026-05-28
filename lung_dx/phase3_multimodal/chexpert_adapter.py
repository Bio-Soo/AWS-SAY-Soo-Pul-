"""CheXpert 14 카테고리 → Phase 3 입력 어댑터 (Option E, 2026-05-14).

배경 (의학 모델 정직성)
═══════════════════════════════════════════════════════════════════
Phase 2 (Team SooNet CXR 모델)는 CheXpert 14 카테고리 + 확률만 출력.
Aurora DB에는 원본 카테고리 그대로 저장. 본 어댑터가 *Phase 3 매칭 단계*
에서 카테고리를 DB의 영상 토큰 (Fleischner 표준 용어)으로 expansion.

Owner 의 5-phase 파이프라인 정의 (2026-05-18 확정):
  Phase 1 = symptom (증상·문진, HPO)
  Phase 2 = X-ray AI (CheXpert 14 라벨)               ← 본 어댑터의 입력 출처
  Phase 3 = multimodal scoring (symptoms + x-ray + lab + micro 통합) ← 본 어댑터의 출력 소비처
  Phase 4 = LLM re-ranking (Phase 1·2·3 value 들을 LLM 으로 정답지 대조·재 ranking)
  Phase 5 = rare disease — **별도 팀 담당**. Phase 1·2·3 value 들로 희귀질환 평가
                          (LIRICAL, Phenopacket). Phase 4 거치지 않는 독립 트랙.

본 어댑터는 Phase 2 → Phase 3 변환만 담당. Phase 4·5 는 본 모듈의 범위 밖.

HPO 변환은 *수행하지 않음* — CheXpert 14 카테고리와 HPO atomic phenotype의
ontologic granularity가 다르고, 1 라벨 → 다수 HPO assertion은 의학적
inference이지 observation이 아니기 때문. HPO는 Phase 1 (증상)과 Phase 5
(희귀질환)에서만 사용. 본 시스템 vocabulary 분담:

  Phase 1 (증상)        : HPO ID            ↔ profile.hpo_phenotypes
  Phase 2 (X-ray)       : CheXpert 카테고리  ↔ profile.ai_imaging_keywords  ← 본 어댑터
  Phase 3 (Lab/Vital)   : LabFinding         ↔ profile.lab_patterns
  Phase 3 (Micro)       : MicroFinding       ↔ profile.micro_findings
  Phase 5 (희귀)        : HPO ID (Phase 1)   ↔ profile.hpo_phenotypes 풀

Expansion table은 data/chexpert_label_reference_v1.yaml에 의학 evidence
(Fleischner 2024 PMID 38411514, ATS/IDSA CAP 2019 PMID 31573350, Komiya
2017 PMID 28841896, BTS Pleural 2023 PMID 37553157 등) 부착되어 있음.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yaml

from ..config.paths import DATA_DIR
from ..domain.findings import Phase2Result, RadiologyFinding, XrayPrediction


CHEXPERT_REFERENCE_YAML = DATA_DIR / "chexpert_label_reference_v1.yaml"

# ── CheXpert 14 라벨 (정식 명칭, CheXpert paper Table 1 기준) ──
CHEXPERT_14_LABELS = (
    "Atelectasis", "Cardiomegaly", "Consolidation", "Edema",
    "Enlarged Cardiomediastinum", "Fracture", "Lung Lesion", "Lung Opacity",
    "No Finding", "Pleural Effusion", "Pleural Other", "Pneumonia",
    "Pneumothorax", "Support Devices",
)


@dataclass(frozen=True)
class LabelExpansion:
    """단일 CheXpert 라벨의 expansion 정의."""
    label: str
    canonical_db_token: str
    expansion: tuple[str, ...]
    out_of_scope: bool = False


class ChexpertReferenceLoader:
    """data/chexpert_label_reference_v1.yaml 로더 (싱글톤 캐시)."""

    _instance: Optional["ChexpertReferenceLoader"] = None

    def __new__(cls) -> "ChexpertReferenceLoader":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load()
        return cls._instance

    def _load(self) -> None:
        if not CHEXPERT_REFERENCE_YAML.exists():
            raise FileNotFoundError(
                f"CheXpert reference YAML 부재: {CHEXPERT_REFERENCE_YAML}. "
                "data/chexpert_label_reference_v1.yaml 생성 필요."
            )
        data = yaml.safe_load(CHEXPERT_REFERENCE_YAML.read_text(encoding="utf-8"))
        self._meta = data.get("metadata", {})
        self._adapter_cfg = data.get("adapter", {})
        self._expansions: dict[str, LabelExpansion] = {}
        for label, payload in data.get("labels", {}).items():
            self._expansions[label] = LabelExpansion(
                label=label,
                canonical_db_token=(payload.get("canonical_db_token") or ""),
                expansion=tuple(payload.get("expansion") or ()),
                out_of_scope=bool(payload.get("out_of_scope", False)),
            )

    @property
    def detection_threshold(self) -> float:
        return float(self._adapter_cfg.get("detection_threshold", 0.5))

    @property
    def possible_threshold(self) -> float:
        return float(self._adapter_cfg.get("possible_threshold", 0.3))

    @property
    def exclude_labels(self) -> frozenset[str]:
        return frozenset(self._adapter_cfg.get("exclude_labels", []))

    @property
    def version(self) -> str:
        return str(self._meta.get("version", "v1"))

    def get(self, label: str) -> Optional[LabelExpansion]:
        return self._expansions.get(label)

    def all_labels(self) -> list[str]:
        return list(self._expansions.keys())


def build_phase2_result(
    chexpert_outputs: list[dict],
    *,
    detection_threshold: Optional[float] = None,
    possible_threshold: Optional[float] = None,
) -> Phase2Result:
    """CheXpert 14 라벨 출력 → Phase2Result.

    Args:
        chexpert_outputs: Aurora DB 또는 inference 출력의 list.
            각 dict: {"label": str, "probability": float}
            label은 CHEXPERT_14_LABELS 중 하나.
        detection_threshold: 미지정 시 reference YAML 값 (기본 0.5).
        possible_threshold: 미지정 시 reference YAML 값 (기본 0.3).

    Returns:
        Phase2Result — ai_keywords_matched가 expansion된 DB 토큰 set으로
        채워짐 (소문자 정규화). detected_findings/possible_findings에
        원본 CheXpert 라벨 + 확률 보존. gradcam_paths는 빈 dict
        (Option E simplified 2026-05-14: 라벨/확률만 추출).

    설계 (Option E):
      Phase 2가 출력하는 14 카테고리는 그대로 detected_findings에 저장하여
      explainability를 보존. Phase 3 R축 매칭은 ai_keywords_matched (expansion
      후 토큰 set)을 사용 — 기존 diagnostic_scorer._calc_radiology_ratio
      로직 변경 없이 호환.
    """
    ref = ChexpertReferenceLoader()
    det_th = detection_threshold if detection_threshold is not None else ref.detection_threshold
    pos_th = possible_threshold if possible_threshold is not None else ref.possible_threshold
    excluded = ref.exclude_labels

    detected: list[RadiologyFinding] = []
    possible: list[RadiologyFinding] = []
    all_predictions: list[XrayPrediction] = []
    expansion_tokens: set[str] = set()

    for entry in chexpert_outputs:
        label = entry.get("label", "")
        prob = float(entry.get("probability", 0.0))

        all_predictions.append(XrayPrediction(label=label, probability=prob))

        # 1) Out-of-scope or excluded label → expansion 생략, finding도 기록 안 함
        if label in excluded:
            continue
        exp = ref.get(label)
        if exp is None:
            # 알 수 없는 라벨 — Phase 4 LLM에 별도 컨텍스트로 전달 가능하지만
            # R축 매칭 대상은 아님
            continue
        if exp.out_of_scope:
            continue

        # 2) 확률 분류 → detected / possible
        if prob >= det_th:
            finding = RadiologyFinding(
                finding=label,
                present=True,
                probability=prob,
                ai_keywords=list(exp.expansion),
            )
            detected.append(finding)
            expansion_tokens.update(t.lower() for t in exp.expansion)
        elif prob >= pos_th:
            finding = RadiologyFinding(
                finding=label,
                present=False,  # possible only
                probability=prob,
                ai_keywords=list(exp.expansion),
            )
            possible.append(finding)
            # possible은 ai_keywords_matched에 포함하지 않음 (보수적 매칭)

    return Phase2Result(
        detected_findings=detected,
        possible_findings=possible,
        all_predictions=all_predictions,
        candidate_icd_codes=[],   # Phase 3 disease_registry가 별도 산출
        ai_keywords_matched=sorted(expansion_tokens),
        gradcam_paths={},          # Option E simplified: Grad-CAM 추출 안 함
    )


def from_aurora_records(records: list[dict]) -> Phase2Result:
    """Aurora DB row list → Phase2Result.

    Aurora DB row schema (Option E simplified, 2026-05-14):
      - chexpert_label (str, one of CHEXPERT_14_LABELS)
      - probability (float)

    가정: 추출 데이터는 라벨/확률 2개 필드만. Grad-CAM/모델 버전/region 등
    부가 메타는 본 함수 가정에서 제외. 필요 시 schema 확장은 별도 라운드.

    본 헬퍼는 단일 환자의 동일 exam 14 row를 받아 Phase2Result로 변환한다.
    호출자가 미리 patient_id/exam_id로 필터링·정렬해야 함.
    """
    chexpert_outputs = [
        {
            "label": r.get("chexpert_label", ""),
            "probability": float(r.get("probability", 0.0)),
        }
        for r in records
    ]
    return build_phase2_result(chexpert_outputs)


__all__ = [
    "CHEXPERT_14_LABELS",
    "CHEXPERT_REFERENCE_YAML",
    "ChexpertReferenceLoader",
    "LabelExpansion",
    "build_phase2_result",
    "from_aurora_records",
]
