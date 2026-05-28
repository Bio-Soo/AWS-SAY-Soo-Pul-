"""Phase 4 메인 entry point — Phase4Verifier.

흐름:
  Phase4Input → BedrockVerifier 호출 → JSON 파싱
            → Guard Rail 6종 적용
            → 통과 시 revised_ranking 반환
            → 실패 시 Phase 3 fallback

설계 근거:
- Fallback 정책: Guard Rail 실패 시 Phase 3 ranking 그대로 사용
  근거: FDA "Good Machine Learning Practice" 2021 Principle 7 —
        "Focus is Placed on the Performance of the Human-AI Team" — AI 응답 미신뢰 시
        기존 검증된 알고리즘 유지(Phase 3 점수)가 환자 안전 우선
- Audit trail: Guard Rail 통과 여부 + raw response 모두 보존
  근거: FDA 510(k) 보조진단 표준 — 모든 결정에 audit trail 의무
       (21 CFR Part 820 Quality System Regulation)
"""
from __future__ import annotations

import json
import logging
from .schemas import (
    Phase4Input, Phase4Result, RevisedDiseaseRanking,
    MissedDiagnosisAlert, Citation, GuardRailReport,
)
from .bedrock_verifier import BedrockPhase4Verifier
from . import guard_rails as gr

logger = logging.getLogger(__name__)


class Phase4Verifier:
    """Phase 4 LLM 검증 + 재 ranking + Guard Rail.

    사용:
        verifier = Phase4Verifier(mode='mock')
        result = verifier.verify(phase4_input, hp_id_to_term={...})
    """

    def __init__(self, mode: str = 'mock', model_id: str = 'anthropic.claude-sonnet-4-6'):
        self._llm = BedrockPhase4Verifier(model_id=model_id, mode=mode)
        self.mode = mode

    def _parse_response(self, raw: str) -> tuple[dict, bool]:
        """LLM JSON 응답 파싱 (코드블록 처리)."""
        text = raw.strip()
        if '```json' in text:
            text = text.split('```json')[1].split('```')[0].strip()
        elif '```' in text:
            text = text.split('```')[1].split('```')[0].strip()
        try:
            return json.loads(text), True
        except json.JSONDecodeError as e:
            logger.warning(f'Phase 4 JSON parse failed: {e}')
            return {}, False

    def _build_revised_ranking(self, parsed: dict) -> list[RevisedDiseaseRanking]:
        ranking = []
        for item in parsed.get('revised_ranking', []):
            citations = [Citation(
                type=c.get('type','PMID'),
                identifier=c.get('identifier',''),
                year=c.get('year'),
                section=c.get('section'),
                title=c.get('title'),
            ) for c in item.get('citations', [])]
            ranking.append(RevisedDiseaseRanking(
                rank=item.get('rank', 0),
                disease_key=item.get('disease_key', ''),
                score=float(item.get('score', 0.0)),
                rank_change=item.get('rank_change', 0),
                rationale=item.get('rationale', ''),
                citations=citations,
            ))
        return ranking

    def _build_alerts(self, parsed: dict) -> list[MissedDiagnosisAlert]:
        alerts = []
        for item in parsed.get('missed_alerts', []):
            citations = [Citation(
                type=c.get('type','PMID'),
                identifier=c.get('identifier',''),
                year=c.get('year'),
                section=c.get('section'),
                title=c.get('title'),
            ) for c in item.get('citations', [])]
            alerts.append(MissedDiagnosisAlert(
                disease_or_condition=item.get('disease_or_condition', ''),
                rationale=item.get('rationale', ''),
                recommended_workup=item.get('recommended_workup', []),
                citations=citations,
            ))
        return alerts

    def _fallback_phase3(self, input_data: Phase4Input,
                         report: GuardRailReport, raw: str,
                         parse_success: bool) -> Phase4Result:
        """Guard Rail 실패 시 Phase 3 ranking 그대로 사용 (안전 우선)."""
        ranking = []
        for i, item in enumerate(input_data.phase3_ranking[:10], 1):
            ranking.append(RevisedDiseaseRanking(
                rank=i,
                disease_key=item.get('disease_key', ''),
                score=float(item.get('score', 0.0)),
                rank_change=0,
                rationale='Guard Rail fallback — Phase 3 점수 ranking 유지 (LLM 검증 미통과)',
                citations=[],
            ))
        return Phase4Result(
            revised_ranking=ranking,
            missed_alerts=[],
            overall_confidence=0.0,  # fallback 명시
            guard_rail_report=report,
            raw_llm_response=raw,
            parse_success=parse_success,
            fallback_to_phase3=True,
            mode=self.mode,
        )

    def verify(
        self,
        input_data: Phase4Input,
        hp_id_to_term: dict[str, str] | None = None,
    ) -> Phase4Result:
        """Phase 4 검증 main flow."""
        hp_id_to_term = hp_id_to_term or {}

        # 1) LLM 호출
        raw = self._llm.call(input_data, hp_id_to_term)

        # 2) JSON 파싱
        parsed, parse_success = self._parse_response(raw)

        # 3) Guard Rail 6종
        all_pass, report = gr.apply_all_guards(
            parsed,
            overall_confidence=parsed.get('overall_confidence'),
        ) if parse_success else (False, GuardRailReport(
            False, False, False, False, False, False,
            [{'guard': 'parse', 'reason': 'JSON parse failed'}]
        ))

        # 4) 통과 → revised_ranking 빌드 / 실패 → fallback
        if all_pass:
            return Phase4Result(
                revised_ranking=self._build_revised_ranking(parsed),
                missed_alerts=self._build_alerts(parsed),
                overall_confidence=float(parsed.get('overall_confidence', 0.0)),
                guard_rail_report=report,
                raw_llm_response=raw,
                parse_success=parse_success,
                fallback_to_phase3=False,
                mode=self.mode,
            )
        else:
            logger.warning(f'Phase 4 Guard Rail 실패 — fallback to Phase 3. report: {report}')
            return self._fallback_phase3(input_data, report, raw, parse_success)
