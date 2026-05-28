"""HPO 증상 매칭 모듈.

환자의 증상(자유 텍스트 또는 HPO ID)을 질환 프로필의
hpo_phenotypes 및 symptoms와 매칭한다.

데이터 소스:
  - lung_disease_profiles_v3_5.yaml의 hpo_phenotypes 49/49 (v3_5: 2026-05-19
    누락 영상 토큰 80+ 추가; v3_4: PMID fabrication fix; v3_3: GOLD 2026 weights; HPO phenotypes는 v3_2와 동일 — symptom
    매칭에 영향 없음)
  - Excel DB ② HPO 표현형 리스트 (일반/기타/희귀)
"""

from __future__ import annotations

from ..domain.findings import SymptomMatch
from ..domain.disease import DiseaseProfile


class SymptomMatcher:
    """환자 증상과 질환 프로필 간 매칭."""

    def match(
        self,
        patient_symptoms: list[str],
        patient_hpo_ids: list[str],
        disease_profiles: list[DiseaseProfile],
    ) -> list[SymptomMatch]:
        """환자 증상을 전체 질환 DB와 매칭.

        Args:
            patient_symptoms: 자유 텍스트 증상 목록
                예: ["cough", "fever", "dyspnea"]
            patient_hpo_ids: HPO ID 목록
                예: ["HP:0012735", "HP:0001945"]
            disease_profiles: 전체 질환 프로필

        Returns:
            매칭된 SymptomMatch 목록.
        """
        # 환자 데이터 정규화
        symptom_set = {s.strip().lower() for s in patient_symptoms if s.strip()}
        hpo_set = {h.strip() for h in patient_hpo_ids if h.strip()}

        matches = []

        # 1) HPO ID 기반 매칭 (정확도 높음)
        for hpo_id in hpo_set:
            matched_diseases = []
            hpo_term = ""
            hpo_kr = ""
            frequency = ""

            for profile in disease_profiles:
                for pheno in profile.hpo_phenotypes:
                    if pheno.get("hpo_id") == hpo_id:
                        matched_diseases.append(profile.disease_key)
                        if not hpo_term:
                            hpo_term = pheno.get("hpo_term", "")
                            hpo_kr = pheno.get("hpo_kr", "")
                            frequency = pheno.get("frequency", "")
                        break

            if matched_diseases:
                matches.append(SymptomMatch(
                    symptom=hpo_term or hpo_id,
                    hpo_id=hpo_id,
                    hpo_kr=hpo_kr,
                    frequency=frequency,
                    matched_diseases=matched_diseases,
                ))

        # 2) 텍스트 기반 매칭 (HPO에 없는 증상)
        matched_hpo_terms = {m.symptom.lower() for m in matches}
        for symptom in symptom_set:
            if symptom in matched_hpo_terms:
                continue  # HPO 매칭에서 이미 처리됨

            matched_diseases = []
            for profile in disease_profiles:
                if self._match_symptom_text(symptom, profile):
                    matched_diseases.append(profile.disease_key)

            if matched_diseases:
                matches.append(SymptomMatch(
                    symptom=symptom,
                    matched_diseases=matched_diseases,
                ))

        return matches

    def extract_matched_disease_keys(
        self, matches: list[SymptomMatch]
    ) -> dict[str, list[str]]:
        """disease_key → [매칭된 증상명] 매핑."""
        result: dict[str, list[str]] = {}
        for m in matches:
            for dk in m.matched_diseases:
                result.setdefault(dk, []).append(m.symptom)
        return result

    def get_patient_hpo_ids(
        self,
        patient_symptoms: list[str],
        disease_profiles: list[DiseaseProfile],
    ) -> set[str]:
        """환자 증상 텍스트를 HPO ID로 변환 (가능한 것만).

        Phase 5 희귀질환 스크리닝에서 HPO 매칭에 사용 (Phase 5 는 별도 팀
        담당 — 본 Phase 3 함수는 데이터만 준비하며 Phase 5 의 내부 로직과
        독립).
        """
        symptom_set = {s.strip().lower() for s in patient_symptoms if s.strip()}
        hpo_ids = set()

        for profile in disease_profiles:
            for pheno in profile.hpo_phenotypes:
                term = pheno.get("hpo_term", "").lower()
                hpo_id = pheno.get("hpo_id", "")
                if term in symptom_set and hpo_id:
                    hpo_ids.add(hpo_id)

            # hpo_symptom_map에서도 변환 (YAML 프로필)
            for symptom_name, hpo_entries in []:
                pass  # hpo_symptom_map은 이미 hpo_phenotypes에 merge됨

        return hpo_ids

    @staticmethod
    def _match_symptom_text(symptom: str, profile: DiseaseProfile) -> bool:
        """자유 텍스트 증상과 프로필 매칭.

        매칭 규칙:
        1. 프로필 symptoms 리스트에서 정확 매칭
        2. HPO 표현형의 hpo_term에서 부분 매칭
        3. HPO 한국어(hpo_kr)에서 매칭
        """
        # 프로필 symptoms (YAML)
        for s in profile.symptoms:
            if symptom == s.lower() or symptom in s.lower():
                return True

        # HPO 표현형
        for pheno in profile.hpo_phenotypes:
            hpo_term = pheno.get("hpo_term", "").lower()
            hpo_kr = pheno.get("hpo_kr", "").lower()
            if symptom in hpo_term or (hpo_kr and symptom in hpo_kr):
                return True

        return False
