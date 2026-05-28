"""Phase 4 system prompt + user message 빌더.

원칙: 모든 prompt는 권위 가이드라인 명시·인용 강제.
LLM이 사견·환각·게으름 응답 못하도록 system level에서 차단.
"""
from __future__ import annotations

import json
from .schemas import Phase4Input


# 권위 가이드라인 — LLM이 인용해야 하는 출처 set (검증 통과)
# 각 항목: {name, year, identifier(PMID/ISBN), 적용 질환}
AUTHORITATIVE_SOURCES = {
    # Pneumonia
    'ats_idsa_cap_2019': {
        'name': 'ATS/IDSA Adult CAP Guidelines',
        'year': 2019, 'identifier': 'PMID:31573350',
        'authors': 'Metlay JP, Waterer GW, et al.',
        'pmcid': 'PMC6812437',
        'applies_to': ['community_acquired_pneumonia'],
    },
    'ats_idsa_hap_2016': {
        'name': 'ATS/IDSA HAP/VAP Guidelines',
        'year': 2016, 'identifier': 'PMID:27418577',
        'authors': 'Kalil AC et al.',
        'applies_to': ['hospital_acquired_pneumonia'],
    },
    'ecil_pcp_2016': {
        'name': 'ECIL Guidelines for treatment of Pneumocystis jirovecii pneumonia',
        'year': 2016, 'identifier': 'PMID:27550993',
        'authors': 'Maschmeyer G et al.',
        'journal': 'J Antimicrob Chemother 71(9):2405-13',
        'applies_to': ['pneumonia_other_organisms'],
        'verified': '2026-04-29 PubMed 직접 확인',
    },
    # COPD/Asthma
    'gold_2026': {
        'name': 'GOLD Report — Global Strategy for COPD',
        'year': 2026, 'identifier': 'goldcopd.org/2026',
        'applies_to': ['copd_exacerbation', 'emphysema', 'chronic_bronchitis'],
    },
    'gina_2024': {
        'name': 'GINA Global Strategy for Asthma',
        'year': 2024, 'identifier': 'ginasthma.org/2024',
        'applies_to': ['asthma_exacerbation'],
    },
    # PE / PH
    'esc_pe_2019': {
        'name': 'ESC Guidelines for Acute PE',
        'year': 2019, 'identifier': 'PMID:31504429',
        'authors': 'Konstantinides SV et al.',
        'applies_to': ['pulmonary_embolism'],
    },
    'esc_ers_ph_2022': {
        'name': 'ESC/ERS Pulmonary Hypertension Guidelines',
        'year': 2022, 'identifier': 'PMID:36017548',
        'applies_to': ['pulmonary_hypertension'],
    },
    # ARDS / HF
    'matthay_ards_2024': {
        'name': 'A New Global Definition of Acute Respiratory Distress Syndrome',
        'year': 2024, 'identifier': 'PMID:37487152',
        'authors': 'Matthay MA et al.',
        'journal': 'Am J Respir Crit Care Med 209(1):37-47',
        'applies_to': ['ards'],
        'verified': '2026-04-29 PubMed 직접 확인',
    },
    'esc_hf_2021': {
        'name': 'ESC HF Guidelines',
        'year': 2021, 'identifier': 'PMID:34447992',
        'applies_to': ['pulmonary_edema'],
    },
    # TB / Other
    'who_tb_2024': {
        'name': 'WHO Operational Handbook on TB',
        'year': 2024, 'identifier': 'WHO/UCN/TB/2024.4',
        'applies_to': ['tuberculosis'],
    },
    'ats_idsa_tb_2017': {
        'name': 'ATS/IDSA/CDC TB Diagnosis',
        'year': 2017, 'identifier': 'PMID:27932390',
        'authors': 'Lewinsohn DM et al.',
        'applies_to': ['tuberculosis'],
    },
    'idsa_flu_2018': {
        'name': 'IDSA Seasonal Influenza Guidelines',
        'year': 2018, 'identifier': 'PMID:30566567',
        'authors': 'Uyeki TM et al.',
        'applies_to': ['influenza', 'viral_pneumonia'],
    },
    'aasm_osa_2017': {
        'name': 'AASM OSA Diagnosis Guidelines',
        'year': 2017, 'identifier': 'PMID:28162150',
        'applies_to': ['sleep_apnea'],
    },
    'nccn_nsclc_2024': {
        'name': 'NCCN NSCLC Guidelines v3.2024',
        'year': 2024, 'identifier': 'nccn.org/guidelines/nsclc',
        'applies_to': ['lung_cancer', 'lung_metastasis', 'mediastinal_pleural_malignancy'],
    },
    'raghu_ipf_2022': {
        'name': 'ATS/ERS/JRS/ALAT IPF Guidelines',
        'year': 2022, 'identifier': 'PMID:35486072',
        'applies_to': ['interstitial_lung_disease'],
    },
    'ers_bronchiectasis_2017': {
        'name': 'ERS Adult Bronchiectasis Guidelines',
        'year': 2017, 'identifier': 'PMID:28889110',
        'applies_to': ['bronchiectasis'],
    },
    'ats_ers_wasog_sarcoid_2020': {
        'name': 'ATS Sarcoidosis Diagnosis Guidelines',
        'year': 2020, 'identifier': 'PMID:32293205',
        'applies_to': ['sarcoidosis'],
    },
    # 표준 교과서
    'harrisons_21': {
        'name': "Harrison's Principles of Internal Medicine 21st Ed",
        'year': 2022, 'identifier': 'ISBN:978-1-264-26849-8',
        'applies_to': ['*'],
    },
    'mandells_9': {
        'name': "Mandell's Infectious Diseases 9th Ed",
        'year': 2020, 'identifier': 'ISBN:978-0-323-48255-4',
        'applies_to': ['*infectious'],
    },
}


SYSTEM_PROMPT = """\
당신은 호흡기 분과전문의 + 의학박사 수준의 임상결정 검증 AI입니다.
역할: Phase 3 (4축 multimodal scoring) 결과를 종합 임상 추론으로 검증·재 ranking.

**필수 권위 출처 (이 set 외 인용 절대 금지)**:
{authoritative_sources_list}

**검토 기준 (전문의 수준)**:
1. Phase 3 ranking이 **임상적으로 합리적**인가? (점수만이 아니라 환자 맥락)
2. 환자 **과거력·약물·면역상태** 고려 시 누락 진단 있는가?
3. 검사 **결합 패턴**이 ranking과 정합한가? (예: 면역억제 + 양측성 GGO → PCP 의심)
4. 가이드라인 **최신 권고 (2024-2026)** 와 정합한가?

**절대 원칙 (위반 시 응답 reject)**:
1. 모든 진단/권고에 **PMID/ISBN/가이드라인 발행연도** 인용 필수
2. 위 권위 출처 set 외 인용 금지 (사견·환각 차단)
3. "추정", "may be", "I think", "possibly", "likely", "seems" 등 **사견 키워드 사용 금지**
4. HP ID 사용 시 제공된 set 외 절대 사용 금지
5. ICD-10 매핑은 WHO Vol.1 (2019) 표준 정합 필수
6. confidence < 0.7 시 "의료진 검토 필요" 명시

**응답 형식 (JSON only, 다른 텍스트 X)**:
{{
  "revised_ranking": [
    {{
      "rank": 1, "disease_key": "...", "score": 0.0-1.0,
      "rank_change": +/-N, "rationale": "...",
      "citations": [{{"type":"PMID","identifier":"PMID:31573350","year":2019,"section":"...","title":"..."}}]
    }}
  ],
  "missed_alerts": [
    {{
      "disease_or_condition": "...", "rationale": "...",
      "recommended_workup": ["..."],
      "citations": [...]
    }}
  ],
  "overall_confidence": 0.0-1.0
}}

응답은 JSON만. 추가 설명 없음. 사견 0%, 출처 100%.
"""


def build_authoritative_list() -> str:
    """system prompt에 삽입할 권위 출처 목록."""
    lines = []
    for key, src in AUTHORITATIVE_SOURCES.items():
        lines.append(
            f"  - {src['name']} ({src['year']}) {src['identifier']}"
            + (f" — {src.get('authors','')}" if src.get('authors') else '')
        )
    return '\n'.join(lines)


def build_system_prompt() -> str:
    return SYSTEM_PROMPT.format(authoritative_sources_list=build_authoritative_list())


def build_user_message(input_data: Phase4Input,
                       hp_id_to_term: dict[str, str]) -> str:
    """환자 데이터 + Phase 3 결과 → user message."""
    # HP IDs with terms (LLM 추론 보조)
    hp_with_terms = [
        f"  {hp}: {hp_id_to_term.get(hp, '?')}"
        for hp in input_data.matched_hp_ids
    ]
    msg = f"""환자 정보:
  - 나이: {input_data.patient_age or '미상'}, 성별: {input_data.patient_sex}
  - 과거력: {', '.join(input_data.patient_history) or '미상'}
  - 현재 복용약: {', '.join(input_data.patient_medications) or '미상'}

X-ray 소견 (Phase 2):
{chr(10).join('  - ' + f for f in input_data.xray_findings) or '  (영상 미수행)'}

매칭된 HP IDs (Phase 1+3 누적):
{chr(10).join(hp_with_terms) or '  (HP 매칭 없음)'}

검사 결과 요약:
{json.dumps(input_data.lab_summary, ensure_ascii=False, indent=2) if input_data.lab_summary else '  (검사 결과 없음)'}

임상 점수:
{json.dumps(input_data.clinical_scores, ensure_ascii=False, indent=2) if input_data.clinical_scores else '  (점수 없음)'}

Phase 3 Top 10 ranking:
{json.dumps(input_data.phase3_ranking[:10], ensure_ascii=False, indent=2)}

위 환자 데이터와 Phase 3 ranking을 검토하여 재 ranking을 JSON으로 출력하세요.
모든 권고에 위 권위 출처 set의 PMID/가이드라인 인용 필수.
"""
    return msg
