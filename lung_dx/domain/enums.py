"""진단 파이프라인 전체에서 공유하는 열거형."""

from enum import Enum


class Confidence(Enum):
    """질환 스코어링 신뢰도."""
    STRONG = "strong"        # score > 0.7
    MODERATE = "moderate"    # 0.4 <= score <= 0.7
    WEAK = "weak"            # score < 0.4


class Severity(Enum):
    """검사값 이상 정도."""
    CRITICAL = "critical"
    ABNORMAL = "abnormal"
    BORDERLINE = "borderline"
    NORMAL = "normal"


class DiseaseCategory(Enum):
    """질환 분류."""
    COMMON = "common"        # 일반 폐질환 (82)
    OTHER = "other"          # 기타 폐관련 질환 (70)
    RARE = "rare"            # 희귀 폐질환 (376)
    YAML_PROFILE = "yaml"    # YAML 상세 프로필 (17)


class DataModality(Enum):
    """진단 데이터 모달리티."""
    SYMPTOMS = "symptoms"
    LAB = "lab"
    RADIOLOGY = "radiology"
    MICROBIOLOGY = "micro"


class HPOFrequency(Enum):
    """Orphanet HPO 빈도 코드 → 가중치 매핑."""
    OBLIGATE = ("HP:0040280", 1.0)       # 100%
    VERY_FREQUENT = ("HP:0040281", 0.8)  # 80-99%
    FREQUENT = ("HP:0040282", 0.6)       # 30-79%
    OCCASIONAL = ("HP:0040283", 0.3)     # 5-29%
    VERY_RARE = ("HP:0040284", 0.1)      # 1-4%

    def __init__(self, hpo_code: str, weight: float):
        self.hpo_code = hpo_code
        self.weight = weight

    @classmethod
    def from_code(cls, code: str) -> "HPOFrequency | None":
        for member in cls:
            if member.hpo_code == code:
                return member
        return None

    @classmethod
    def weight_for_code(cls, code: str, default: float = 0.5) -> float:
        member = cls.from_code(code)
        return member.weight if member else default
