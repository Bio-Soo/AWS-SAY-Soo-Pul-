"""Phase 4 Bedrock Sonnet 호출기 (mock + real mode).

설계 근거:
- 모델: anthropic.claude-sonnet-4-6 (의학박사 수준 추론, NEJM/Lancet/JAMA 학습 포함)
- temperature: 0.0 (재현가능성 보장 — 의학 임상 의사결정 표준)
  근거: FDA "Good Machine Learning Practice for Medical Device Development" 2021
        (FDA-CDRH 2021-10-27, Health Canada, MHRA 공동 발표) — Principle 9
        "Deployed Models Are Monitored for Performance and Re-training Risks
         are Managed" — temperature 0 deterministic 출력이 임상 검증·감사에 표준
- max_tokens: 2048 (최대 10 disease ranking + 5 alerts 충분)
- 인용 출처: https://www.fda.gov/medical-devices/software-medical-device-samd/
              good-machine-learning-practice-medical-device-development-guiding-principles
"""
from __future__ import annotations

import json
import logging
from .schemas import Phase4Input
from .prompt_builder import build_system_prompt, build_user_message

logger = logging.getLogger(__name__)


# ── Mock responses (fact-based, 권위 출처 인용) ──────────────
# 사용 시나리오: AWS 자격증명 없을 때 framework 검증
MOCK_RESPONSES = {
    # 시나리오 키 = (top_disease, has_alcohol, on_steroid)
    'cap_baseline': {
        'revised_ranking': [
            {
                'rank': 1, 'disease_key': 'community_acquired_pneumonia',
                'score': 0.85, 'rank_change': 0,
                'rationale': '발열 + 농성 객담 + 폐 침윤 + WBC 상승 → ATS/IDSA CAP 2019 minor criteria 충족.',
                'citations': [
                    {'type': 'PMID', 'identifier': 'PMID:31573350', 'year': 2019,
                     'section': 'Severity criteria',
                     'title': 'ATS/IDSA Adult CAP Guidelines'}
                ]
            }
        ],
        'missed_alerts': [],
        'overall_confidence': 0.82,
    },
    'aspiration_steroid_complex': {
        'revised_ranking': [
            {
                'rank': 1, 'disease_key': 'aspiration_pneumonia',
                'score': 0.88, 'rank_change': 5,
                'rationale': '알콜중독 + 우하엽 consolidation = 흡인 우선 의심. 중력 분포 일치.',
                'citations': [
                    {'type': 'ISBN', 'identifier': 'ISBN:978-0-323-48255-4', 'year': 2020,
                     'section': "Ch.65 Aspiration syndromes",
                     'title': "Mandell's Infectious Diseases 9th Ed"}
                ]
            },
            {
                'rank': 2, 'disease_key': 'pneumonia_other_organisms',
                'score': 0.78, 'rank_change': 5,
                'rationale': 'Prednisone = 면역억제. PCP 감별 필수. BAL + (1,3)-β-D-glucan 권고.',
                'citations': [
                    {'type': 'PMID', 'identifier': 'PMID:27550993', 'year': 2016,
                     'section': 'Treatment recommendations',
                     'title': 'ECIL Guidelines for Pneumocystis jirovecii pneumonia'}
                ]
            },
            {
                'rank': 3, 'disease_key': 'community_acquired_pneumonia',
                'score': 0.72, 'rank_change': -2,
                'rationale': 'CAP 가능하나 면역억제 환자에서 atypical pathogen 우선 고려.',
                'citations': [
                    {'type': 'PMID', 'identifier': 'PMID:31573350', 'year': 2019,
                     'section': 'Risk stratification',
                     'title': 'ATS/IDSA Adult CAP Guidelines'}
                ]
            }
        ],
        'missed_alerts': [
            {
                'disease_or_condition': '결핵 재활성화',
                'rationale': 'Prednisone + 우하엽 consolidation. 면역억제 환자 결핵 재활성 위험.',
                'recommended_workup': ['IGRA', '객담 AFB smear/culture', 'TB-PCR Xpert'],
                'citations': [
                    {'type': 'PMID', 'identifier': 'PMID:27932390', 'year': 2017,
                     'section': 'TB diagnostic algorithm',
                     'title': 'ATS/IDSA/CDC TB Diagnosis Guidelines'}
                ]
            }
        ],
        'overall_confidence': 0.85,
    },
}


class BedrockPhase4Verifier:
    """Phase 4 LLM 검증기 — Bedrock Sonnet 호출.

    설계 근거:
    - Bedrock Anthropic Claude: 의학 학술지 광범위 학습 (NEJM/Lancet/JAMA/AJRCCM)
    - Sonnet 모델 선택 사유: Phase 4는 의학 추론 + 가이드라인 cross-check 필요 — Sonnet 4.6 의학박사 수준
    - Phase 1은 Haiku (간단 추출) — 비용 차별화
    """

    def __init__(
        self,
        model_id: str = 'anthropic.claude-sonnet-4-6',
        region: str = 'us-east-1',
        mode: str = 'mock',
    ):
        self.model_id = model_id
        self.region = region
        self.mode = mode
        self._client = None

    def _get_client(self):
        if self._client is None:
            import boto3
            self._client = boto3.client('bedrock-runtime', region_name=self.region)
        return self._client

    def _call_bedrock(self, system_prompt: str, user_msg: str) -> str:
        """실제 Bedrock 호출 — 결정적 (temperature 0.0)."""
        client = self._get_client()
        response = client.invoke_model(
            modelId=self.model_id,
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 2048,
                'temperature': 0.0,  # 재현가능성
                'system': system_prompt,
                'messages': [{'role': 'user', 'content': user_msg}],
            })
        )
        body = json.loads(response['body'].read())
        return body['content'][0]['text']

    def _call_mock(self, input_data: Phase4Input) -> str:
        """Mock 응답 — 시나리오 키 매칭."""
        # 간단한 시나리오 분류
        meds_lower = ' '.join(input_data.patient_medications).lower()
        history_lower = ' '.join(input_data.patient_history).lower()

        if 'prednisone' in meds_lower or '알콜' in history_lower or 'alcohol' in history_lower:
            response = MOCK_RESPONSES['aspiration_steroid_complex']
        else:
            response = MOCK_RESPONSES['cap_baseline']

        return json.dumps(response, ensure_ascii=False)

    def call(self, input_data: Phase4Input,
             hp_id_to_term: dict[str, str]) -> str:
        """LLM 호출 → raw response text."""
        system = build_system_prompt()
        user = build_user_message(input_data, hp_id_to_term)
        if self.mode == 'real':
            return self._call_bedrock(system, user)
        else:
            return self._call_mock(input_data)
