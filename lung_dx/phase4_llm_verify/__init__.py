"""v2 Phase 4: LLM 검증 + 재 ranking (의학박사 수준 + Guard Rail 6종).

흐름:
  Phase 3 (4축 점수) → Phase 4 LLM 검증 → 재 ranking + 누락 alert

설계 근거:
- Bedrock Sonnet 4.6: NEJM/Lancet/JAMA/AJRCCM 학습된 의학박사 수준 추론
- Temperature 0.0: 재현가능성 (임상 의사결정 표준)
- Guard Rail 6종: 사견·환각·게으름 차단
- Fallback: Guard Rail 실패 시 Phase 3 ranking 유지 (안전 우선)

권위 출처 set (인용 강제, 외부 출처 금지) — 자세한 검증은 REFERENCES_VERIFIED.md 참조.

신설: 2026-04-29
"""
from .schemas import (
    Phase4Input, Phase4Result, RevisedDiseaseRanking,
    MissedDiagnosisAlert, Citation, GuardRailReport,
)
from .prompt_builder import AUTHORITATIVE_SOURCES, build_system_prompt, build_user_message
from .bedrock_verifier import BedrockPhase4Verifier
from .guard_rails import (
    apply_all_guards, guard_hp_id, guard_disease_key, guard_citation,
    guard_confidence, guard_no_hallucination, guard_schema,
)
from .verifier import Phase4Verifier

__all__ = [
    'Phase4Input', 'Phase4Result', 'RevisedDiseaseRanking',
    'MissedDiagnosisAlert', 'Citation', 'GuardRailReport',
    'AUTHORITATIVE_SOURCES', 'build_system_prompt', 'build_user_message',
    'BedrockPhase4Verifier',
    'apply_all_guards', 'guard_hp_id', 'guard_disease_key', 'guard_citation',
    'guard_confidence', 'guard_no_hallucination', 'guard_schema',
    'Phase4Verifier',
]
