"""미생물 소견 분석 모듈.

환자의 미생물 소견(임상의 입력)을 질환 DB의 micro_findings와 매칭한다.
microbiologyevents.csv는 사용하지 않으며, 데이터 소스:
  - lung_disease_profiles_v2.yaml의 micro_findings
  - Excel DB "미생물 소견" 컬럼
  - lab_reference_ranges_v3.yaml J_Infection_Microbiology 10개 항목
"""

from __future__ import annotations

from ..domain.findings import MicroFinding
from ..domain.disease import DiseaseProfile


class MicroAnalyzer:
    """환자의 미생물 소견과 질환 프로필의 micro_findings를 매칭."""

    def analyze(
        self,
        patient_micro: list[str],
        disease_profiles: list[DiseaseProfile],
    ) -> list[MicroFinding]:
        """환자 미생물 소견을 전체 질환 DB와 매칭.

        Args:
            patient_micro: 환자에서 검출된 균종명/검사결과 목록
                예: ["Streptococcus pneumoniae", "AFB positive",
                     "Aspergillus GM positive"]
            disease_profiles: 전체 질환 프로필 목록 (DiseaseRegistry.get_all())

        Returns:
            매칭된 MicroFinding 목록.
        """
        if not patient_micro:
            return []

        patient_terms = {m.strip().lower() for m in patient_micro if m.strip()}
        findings = []

        for term in patient_micro:
            term_clean = term.strip()
            if not term_clean:
                continue

            term_lower = term_clean.lower()
            matched_diseases = []

            for profile in disease_profiles:
                if self._match_micro(term_lower, profile.micro_findings):
                    matched_diseases.append(profile.disease_key)

            findings.append(MicroFinding(
                organism=term_clean,
                matched_diseases=matched_diseases,
            ))

        return findings

    def extract_matched_disease_keys(
        self, findings: list[MicroFinding]
    ) -> dict[str, list[str]]:
        """disease_key → [매칭된 균종명] 매핑.

        diagnostic_scorer에서 질환별 micro 매칭 비율 계산에 사용.
        """
        result: dict[str, list[str]] = {}
        for f in findings:
            for dk in f.matched_diseases:
                result.setdefault(dk, []).append(f.organism)
        return result

    @staticmethod
    def _match_micro(patient_term: str, profile_micro: list[str]) -> bool:
        """환자 미생물 소견과 프로필 micro_findings 매칭.

        매칭 규칙 (임상적 관례 반영):
        1. 정확히 일치 (대소문자 무시)
        2. 속(genus) 수준 매칭: "Streptococcus" ⊂ "Streptococcus pneumoniae"
        3. 부분 문자열 매칭: "AFB positive" ↔ "AFB"

        [Mandell's Infectious Diseases 9th Ed Ch.16 — 미생물 동정 원칙]
        """
        for criterion in profile_micro:
            criterion_lower = criterion.strip().lower()
            if not criterion_lower:
                continue
            # 정확 매칭
            if patient_term == criterion_lower:
                return True
            # 부분 매칭 (양방향)
            if patient_term in criterion_lower or criterion_lower in patient_term:
                return True
        return False
