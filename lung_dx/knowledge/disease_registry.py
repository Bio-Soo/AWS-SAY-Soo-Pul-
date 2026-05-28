"""528개 폐질환 통합 레지스트리.

데이터 소스:
  1. 일반_폐질환_데이터베이스_v9.xlsx  (v9: Q22 제거 동기화 2026-05-19 / v8: GOLD 2026 v1.3 기반 COPD/Emphysema/
     Chronic bronchitis weights 재설계 7행, 2026-05-14)
  2. 기타_폐관련_질환_데이터베이스_v9.xlsx  (v9: Q22 폐동맥판/삼첨판 선천기형 제거 — 의학적 fact 기반 CHD 분류, 2026-05-19)
  3. 희귀_폐질환_데이터베이스_v5.xlsx
  4. lung_disease_profiles_v3_5.yaml  (49 질환 — hpo_phenotypes 49/49 + GOLD 2026
     기반 weights 재설계, weight_rationale 필드 + PMID fabrication fix + 누락 영상 토큰 80+ 추가 2026-05-19)

YAML 49개 질환은 Excel DB와 중복될 수 있으며,
YAML 데이터가 더 상세하므로 YAML을 우선 적용(merge)한다.

NOTE (2026-05-06): lung_disease_symptoms_v3.yaml은 profiles_v3_2 빌드 시점부터
hpo_phenotypes 풀이 profile에 통합되어 redundant — `data/obsoleted/`로 이동.

NOTE (2026-05-14): v3_3 weights는 GOLD 2026 Report v1.3 (released 2025-12-08)
p.46 "A chest X-ray is not useful to establish a diagnosis in COPD" 본문에
근거하여 copd_exacerbation/emphysema/chronic_bronchitis R축을 0.25-0.40 →
0.10으로 일괄 하향, S/L축 상향. 각 변경의 상세 사유와 PMID는 YAML 각 그룹의
`weight_rationale` 필드와 `data/lung_disease_v7_to_v8_변경대비표.xlsx` 참조.
"""

from __future__ import annotations

import logging
from typing import Optional

import yaml

from ..config import paths
from ..domain.disease import DiseaseProfile
from ..domain.enums import DiseaseCategory
from .excel_loader import (
    load_common_or_other_diseases,
    load_rare_diseases,
)

logger = logging.getLogger(__name__)


class DiseaseRegistry:
    """528개 질환 통합 레지스트리 + 역인덱스."""

    def __init__(self):
        self._profiles: dict[str, DiseaseProfile] = {}
        # YAML key → 실제 profile key 매핑
        # (YAML 병합 시 Excel 키로 저장되므로 역참조 필요)
        self._yaml_key_map: dict[str, str] = {}
        # 역인덱스
        self._icd10_index: dict[str, list[str]] = {}     # ICD-10 → [disease_key]
        self._keyword_index: dict[str, list[str]] = {}    # AI keyword → [disease_key]
        self._hpo_index: dict[str, list[str]] = {}        # HPO ID → [disease_key]
        self._loaded = False

    # ── 로드 ──────────────────────────────────────────────────
    def load(self) -> None:
        """7개 데이터 소스에서 전체 질환 레지스트리를 구축한다."""
        # 1) Excel DB 로드
        common = load_common_or_other_diseases(
            str(paths.COMMON_DISEASE_XLSX), DiseaseCategory.COMMON
        )
        other = load_common_or_other_diseases(
            str(paths.OTHER_DISEASE_XLSX), DiseaseCategory.OTHER
        )
        rare = load_rare_diseases(str(paths.RARE_DISEASE_XLSX))

        for profile in common + other + rare:
            self._add_profile(profile)

        # 2) YAML 상세 프로필 병합 (17개)
        self._merge_yaml_profiles()

        # 3) 역인덱스 구축
        self._build_indexes()
        self._loaded = True

        logger.info(
            "DiseaseRegistry loaded: %d diseases "
            "(common=%d, other=%d, rare=%d, yaml_enriched=%d)",
            len(self._profiles),
            sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.COMMON),
            sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.OTHER),
            sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.RARE),
            sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.YAML_PROFILE),
        )

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self.load()

    def _add_profile(self, profile: DiseaseProfile) -> None:
        """프로필 추가. key 충돌 시 기존 것과 merge."""
        key = profile.disease_key
        if key in self._profiles:
            # 동일 키 충돌 → ICD-10 추가해서 유니크하게
            suffix = 2
            while f"{key}_{suffix}" in self._profiles:
                suffix += 1
            key = f"{key}_{suffix}"
            profile.disease_key = key
        self._profiles[key] = profile

    def _merge_yaml_profiles(self) -> None:
        """YAML 49개 상세 프로필을 기존 Excel 프로필에 병합.

        YAML은 weights, symptoms, lab_patterns, radiology_findings,
        micro_findings, hpo_phenotypes(49/49) 가 더 상세하다.
        """
        profiles_data = self._load_yaml(str(paths.DISEASE_PROFILES_YAML))

        for yaml_key, data in profiles_data.items():
            # Excel에서 동일 질환 찾기 (disease_key 또는 ICD-10 매칭)
            existing = self._find_matching_profile(yaml_key, data)

            if existing:
                self._enrich_profile(existing, data)
                existing.category = DiseaseCategory.YAML_PROFILE
                self._yaml_key_map[yaml_key] = existing.disease_key
            else:
                profile = self._yaml_to_profile(yaml_key, data)
                self._profiles[yaml_key] = profile
                self._yaml_key_map[yaml_key] = yaml_key

    def _find_matching_profile(
        self, yaml_key: str, data: dict
    ) -> Optional[DiseaseProfile]:
        """YAML 키 또는 ICD-10으로 기존 프로필 검색."""
        # 1) disease_key 직접 매칭
        if yaml_key in self._profiles:
            return self._profiles[yaml_key]

        # 2) ICD-10 코드로 매칭
        yaml_icd = set(data.get("icd10", []))
        for profile in self._profiles.values():
            if yaml_icd & set(profile.icd10_codes):
                return profile
        return None

    def _enrich_profile(self, profile: DiseaseProfile, yaml_data: dict) -> None:
        """기존 프로필에 YAML 상세 데이터를 보강."""
        w = yaml_data.get("weights", {})
        if w:
            profile.weight_symptoms = w.get("symptoms", profile.weight_symptoms)
            profile.weight_lab = w.get("lab", profile.weight_lab)
            profile.weight_radiology = w.get("radiology", profile.weight_radiology)
            profile.weight_micro = w.get("micro", profile.weight_micro)

        # v3_6 (2026-05-19): YAML icd10 list를 profile.icd10_codes에 merge
        # 결함: enrich path는 Excel에서 1 ICD만 받은 profile에 YAML 추가 ICD가 갱신되지 않음
        # → sub_code_radiology_findings 매칭이 동작 불가 (profile에 sub-code 부재)
        yaml_icd = yaml_data.get("icd10", [])
        if yaml_icd:
            existing = set(profile.icd10_codes)
            for icd in yaml_icd:
                if icd not in existing:
                    profile.icd10_codes.append(icd)
                    existing.add(icd)

        if yaml_data.get("lab_patterns"):
            profile.lab_patterns = yaml_data["lab_patterns"]
        if yaml_data.get("radiology_findings"):
            profile.radiology_findings = yaml_data["radiology_findings"]
        if yaml_data.get("sub_code_radiology_findings"):
            profile.sub_code_radiology_findings = yaml_data["sub_code_radiology_findings"]
        if yaml_data.get("micro_findings"):
            profile.micro_findings = yaml_data["micro_findings"]
        if yaml_data.get("symptoms"):
            # YAML 증상이 더 상세하므로 교체
            profile.symptoms = yaml_data["symptoms"]
        if yaml_data.get("icd11"):
            profile.icd11_code = yaml_data["icd11"]
        if yaml_data.get("icd9"):
            profile.icd9_code = str(yaml_data["icd9"])
        if yaml_data.get("disease_kr"):
            profile.name_kr = yaml_data["disease_kr"]

        # 진단 차단 플래그 (비-폐질환 / 상기도 / 위험인자)
        if "diagnostic_active" in yaml_data:
            profile.diagnostic_active = bool(yaml_data["diagnostic_active"])
        if yaml_data.get("exclusion_reason"):
            profile.exclusion_reason = yaml_data["exclusion_reason"]
        if yaml_data.get("exclusion_category"):
            profile.exclusion_category = yaml_data["exclusion_category"]
        if yaml_data.get("exclusion_reference"):
            profile.exclusion_reference = yaml_data["exclusion_reference"]

        # hpo_phenotypes 풀이 profile에 이미 풍부 (v3.2 49/49). hpo_symptom_map은
        # 백업 매핑으로만 사용 — 누락된 hpo_id가 있으면 추가.
        hpo_map = yaml_data.get("hpo_symptom_map", {})
        if hpo_map:
            existing_hpo_ids = {h["hpo_id"] for h in profile.hpo_phenotypes}
            for symptom_name, hpo_id in hpo_map.items():
                if hpo_id not in existing_hpo_ids:
                    profile.hpo_phenotypes.append({
                        "hpo_id": hpo_id,
                        "hpo_term": symptom_name,
                        "hpo_kr": "",
                        "frequency": "",
                    })

        # profile.hpo_phenotypes 본체는 yaml_data["hpo_phenotypes"]에서 직접 사용.
        if yaml_data.get("hpo_phenotypes"):
            existing_ids = {h["hpo_id"] for h in profile.hpo_phenotypes}
            for ph in yaml_data["hpo_phenotypes"]:
                hpo_id = ph.get("hpo_id", "")
                if hpo_id and hpo_id not in existing_ids:
                    profile.hpo_phenotypes.append({
                        "hpo_id": hpo_id,
                        "hpo_term": ph.get("hpo_term", ""),
                        "hpo_kr": ph.get("hpo_kr", ""),
                        "frequency": ph.get("frequency", ""),
                    })
                    existing_ids.add(hpo_id)

    def _yaml_to_profile(self, yaml_key: str, data: dict) -> DiseaseProfile:
        """YAML 데이터로 새 DiseaseProfile 생성."""
        w = data.get("weights", {})
        hpo_map = data.get("hpo_symptom_map", {})
        hpo_list = [
            {"hpo_id": hpo_id, "hpo_term": name, "hpo_kr": "", "frequency": ""}
            for name, hpo_id in hpo_map.items()
        ]
        # profile의 hpo_phenotypes 풀에서 누락분 보강 (frequency/한글명 포함).
        if data.get("hpo_phenotypes"):
            existing_ids = {h["hpo_id"] for h in hpo_list}
            for ph in data["hpo_phenotypes"]:
                hpo_id = ph.get("hpo_id", "")
                if hpo_id and hpo_id not in existing_ids:
                    hpo_list.append({
                        "hpo_id": hpo_id,
                        "hpo_term": ph.get("hpo_term", ""),
                        "hpo_kr": ph.get("hpo_kr", ""),
                        "frequency": ph.get("frequency", ""),
                    })
                    existing_ids.add(hpo_id)

        return DiseaseProfile(
            disease_key=yaml_key,
            name_en=yaml_key.replace("_", " ").title(),
            name_kr=data.get("disease_kr", ""),
            category=DiseaseCategory.YAML_PROFILE,
            icd10_codes=data.get("icd10", []),
            icd11_code=data.get("icd11", ""),
            icd9_code=str(data.get("icd9", "")),
            weight_symptoms=w.get("symptoms", 0.25),
            weight_lab=w.get("lab", 0.20),
            weight_radiology=w.get("radiology", 0.35),
            weight_micro=w.get("micro", 0.20),
            symptoms=data.get("symptoms", []),
            hpo_phenotypes=hpo_list,
            lab_patterns=data.get("lab_patterns", []),
            radiology_findings=data.get("radiology_findings", []),
            sub_code_radiology_findings=data.get("sub_code_radiology_findings", {}),
            micro_findings=data.get("micro_findings", []),
        )

    # ── 역인덱스 ──────────────────────────────────────────────
    def _build_indexes(self) -> None:
        self._icd10_index.clear()
        self._keyword_index.clear()
        self._hpo_index.clear()

        for key, profile in self._profiles.items():
            # ICD-10 인덱스
            for code in profile.icd10_codes:
                self._icd10_index.setdefault(code, []).append(key)

            # AI 키워드 인덱스
            for kw in profile.ai_imaging_keywords:
                kw_lower = kw.lower().strip()
                if kw_lower:
                    self._keyword_index.setdefault(kw_lower, []).append(key)

            # HPO 인덱스
            for hpo in profile.hpo_phenotypes:
                hpo_id = hpo.get("hpo_id", "")
                if hpo_id:
                    self._hpo_index.setdefault(hpo_id, []).append(key)

    # ── 조회 API ──────────────────────────────────────────────
    @property
    def count(self) -> int:
        self._ensure_loaded()
        return len(self._profiles)

    def get_by_key(self, disease_key: str) -> Optional[DiseaseProfile]:
        self._ensure_loaded()
        return self._profiles.get(disease_key)

    def get_all(self) -> list[DiseaseProfile]:
        self._ensure_loaded()
        return list(self._profiles.values())

    def get_by_category(self, category: DiseaseCategory) -> list[DiseaseProfile]:
        self._ensure_loaded()
        return [p for p in self._profiles.values() if p.category == category]

    def search_by_icd10(self, code: str) -> list[DiseaseProfile]:
        self._ensure_loaded()
        keys = self._icd10_index.get(code, [])
        return [self._profiles[k] for k in keys if k in self._profiles]

    def search_by_keyword(self, keyword: str) -> list[DiseaseProfile]:
        """AI 영상 키워드로 질환 검색."""
        self._ensure_loaded()
        keys = self._keyword_index.get(keyword.lower().strip(), [])
        return [self._profiles[k] for k in keys if k in self._profiles]

    def search_by_keywords(self, keywords: list[str]) -> list[DiseaseProfile]:
        """여러 키워드 중 하나라도 매칭되는 질환 검색."""
        self._ensure_loaded()
        matched_keys = set()
        for kw in keywords:
            matched_keys.update(self._keyword_index.get(kw.lower().strip(), []))
        return [self._profiles[k] for k in matched_keys if k in self._profiles]

    def search_by_hpo(self, hpo_id: str) -> list[DiseaseProfile]:
        self._ensure_loaded()
        keys = self._hpo_index.get(hpo_id, [])
        return [self._profiles[k] for k in keys if k in self._profiles]

    def count_diseases_with_hpo(self, hpo_id: str) -> int:
        """특정 HPO를 가진 질환 수 (Information Content 계산용)."""
        self._ensure_loaded()
        return len(self._hpo_index.get(hpo_id, []))

    def get_diseases_with_genes(self) -> list[DiseaseProfile]:
        """유전자 정보가 있는 질환만 반환."""
        self._ensure_loaded()
        return [p for p in self._profiles.values() if p.major_genes]

    def get_all_unique_hpo_ids(self) -> set[str]:
        self._ensure_loaded()
        return set(self._hpo_index.keys())

    def get_all_unique_keywords(self) -> set[str]:
        self._ensure_loaded()
        return set(self._keyword_index.keys())

    def resolve_yaml_key(self, yaml_key: str) -> str:
        """YAML disease_key를 실제 profile key로 변환.

        YAML disease_associations의 disease_key(예: 'community_acquired_pneumonia')
        가 Excel 병합으로 다른 키(예: 'bacterial_pneumonia_nec')로 저장된 경우
        실제 키를 반환한다. 매핑이 없으면 원본 키를 그대로 반환.
        """
        self._ensure_loaded()
        return self._yaml_key_map.get(yaml_key, yaml_key)

    @property
    def yaml_key_map(self) -> dict[str, str]:
        self._ensure_loaded()
        return dict(self._yaml_key_map)

    # ── 유틸 ──────────────────────────────────────────────────
    @staticmethod
    def _load_yaml(path: str) -> dict:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def summary(self) -> dict[str, int]:
        """레지스트리 요약 통계."""
        self._ensure_loaded()
        return {
            "total": len(self._profiles),
            "common": sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.COMMON),
            "other": sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.OTHER),
            "rare": sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.RARE),
            "yaml_enriched": sum(1 for p in self._profiles.values() if p.category == DiseaseCategory.YAML_PROFILE),
            "with_ai_keywords": sum(1 for p in self._profiles.values() if p.ai_imaging_keywords),
            "with_lab_patterns": sum(1 for p in self._profiles.values() if p.lab_patterns),
            "with_genes": sum(1 for p in self._profiles.values() if p.major_genes),
            "unique_hpo_ids": len(self._hpo_index),
            "unique_keywords": len(self._keyword_index),
        }
