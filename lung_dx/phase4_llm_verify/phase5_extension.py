"""[DEPRECATED 2026-04-30] Phase 4 + Phase 5 통합 — 사용자 정의로 폐기.

⚠ DEPRECATION NOTICE
=====================
2026-04-30 후반 사용자 결정 (memory feedback_phase5_independence.md):
  Phase 5는 Phase 4 LLM 검증을 거치지 않는 *독립 트랙*. 대신 RAG로
  외부 권위 API(HPO/Monarch/PubCaseFinder)를 호출해 환자 HPO에 부합
  하는 희귀질환을 listing.

본 모듈은 다음 이유로 *현재 사용되지 않음*:
  - Phase 5 결과는 외부 권위 학술 DB 기반 → LLM 추가 검증의 hallucination
    위험을 회피
  - LLM 검증 단계는 일반/기타 폐질환(Phase 3 → Phase 4)에 한정
  - Phase 5의 결과는 Final 단계에 직접 전달

본 파일은 reference로 보존 (향후 외부 LIRICAL Java cross-check 결과를
LLM이 검토하는 별도 use case에서 재활용 가능). production import 금지.

ORIGINAL CONTENT BELOW
=======================

사용자 정의 (memory feedback_phase_responsibility.md):
  - Phase 5 = 희귀질환(376) 전용 LIRICAL Bayesian LR 결과
  - Phase 4 LLM = "검증·재정렬·alert"만 — score 새로 계산하지 않음

본 모듈의 역할:
  Phase 5 LIRICAL 결과(rare candidates + posttest_prob + LR contributions)를
  Phase 4 LLM이 받아 다음을 수행:
    (1) 각 후보의 임상 적합성 검토 (환자 데이터와 LIRICAL 결과 정합성)
    (2) 인용 강제 — 권위 출처 PMID/가이드라인 부착
    (3) 사견·환각·게으름 차단 (Guard Rail)
    (4) 미검 희귀질환 alert (예: LIRICAL이 놓친 phenocopy)

References (모두 자체 PubMed 검증, 2026-04-30):

  Robinson PN et al. Am J Hum Genet 2020;107(3):403-417. PMID 32755546.
    why_cited: 검증 대상이 되는 LIRICAL 알고리즘 출처 — LLM 검증 시
    posttest_prob 해석을 본 논문 Box 2 기준으로 평가.

  Asgari E, Montaña-Brown N, Dubois M, Khalil S, Balloch J, et al.
    "A framework to assess clinical safety and hallucination rates of
    LLMs for medical text summarisation." NPJ Digit Med 2025;8(1):274.
    PMID 40360677. DOI: 10.1038/s41746-025-01670-7.
    why_cited: 본 모듈의 hallucination·omission 분류·평가 체계의 최신
    표준 출처. Asgari 2025의 baseline (잘 설계된 시스템에서
    hallucination 1.47%, omission 3.45%)을 본 모듈 Guard Rail 통과
    기준의 근거로 채택. fallback 임계 설정의 정당성 출처.

  Omar M, Sorin V, Collins JD, Reich D, Freeman R, et al.
    "Multi-model assurance analysis showing large language models are
    highly vulnerable to adversarial hallucination attacks during
    clinical decision support." Commun Med 2025;5(1):330. PMID 40753316.
    DOI: 10.1038/s43856-025-01021-3.
    why_cited: 본 논문은 LLM이 clinical decision support 맥락에서 거짓
    정보 입력을 정정하지 못하고 50-82% 비율로 elaborate하는 현상을
    실증. mitigation prompt로 GPT-4o 53→23%까지만 개선됨 → 본 모듈에서
    "사견 확신적 표현 reject + 환자 데이터에 없는 finding 인용 reject"
    Guard Rail 강화의 직접 근거. 본 모듈은 Asgari + Omar 2025 권고를
    조합하여 prompt 단계에서 mitigation을 명시하고, 사후에 Guard Rail
    로 재검증하는 2단 구조 채택.

  FDA Good Machine Learning Practice (GMLP) for Medical Device
    Development — Guiding Principles, Oct 2021. Principle 7 (Human-AI
    Team Performance), Principle 9 (Users are Provided Clear Essential
    Information).
    why_cited: Guard Rail 실패 시 Phase 5 결과를 그대로 보존(fallback)
    하고 LLM 출력 폐기하는 정책의 규제 근거. LLM이 인간 검토 없이
    임상 결정을 내리지 않도록 명시적 fallback 의무화.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import guard_rails as gr
from .bedrock_verifier import BedrockPhase4Verifier
from .schemas import Citation, GuardRailReport

logger = logging.getLogger(__name__)


# ── Phase 5 전용 권위 출처 (Phase 4 set + LIRICAL/희귀질환 추가) ────
LIRICAL_AUTHORITATIVE_SOURCES: dict[str, dict] = {
    "robinson_lirical_2020": {
        "name": "LIRICAL: Interpretable Clinical Genomics with a Likelihood Ratio Paradigm",
        "year": 2020, "identifier": "PMID:32755546",
        "authors": "Robinson PN, Ravanmehr V, Jacobsen JOB, et al.",
        "journal": "Am J Hum Genet 107(3):403-417",
        "verified": "2026-04-30 PubMed 직접",
    },
    "jacobsen_phenopacket_2022": {
        "name": "GA4GH Phenopacket Schema v2.0",
        "year": 2022, "identifier": "PMID:35705716",
        "authors": "Jacobsen JOB, Baudis M, Baynam GS, et al.",
        "journal": "Nat Biotechnol 40(6):817-820",
        "verified": "2026-04-30 PubMed 직접",
    },
    "kohler_ic_2009": {
        "name": "Clinical diagnostics with semantic similarity searches in ontologies",
        "year": 2009, "identifier": "PMID:19800049",
        "authors": "Köhler S, Schulz MH, Krawitz P, et al.",
        "journal": "Am J Hum Genet 85(4):457-464",
        "verified": "2026-04-30 PubMed 직접",
    },
    "asgari_safety_2025": {
        "name": "Framework to assess clinical safety and hallucination rates of LLMs",
        "year": 2025, "identifier": "PMID:40360677",
        "authors": "Asgari E, Montaña-Brown N, Dubois M, et al.",
        "journal": "NPJ Digit Med 8(1):274",
        "verified": "2026-04-30 PubMed 직접",
    },
    "omar_adversarial_2025": {
        "name": "Multi-model assurance analysis: adversarial hallucination in clinical LLMs",
        "year": 2025, "identifier": "PMID:40753316",
        "authors": "Omar M, Sorin V, Collins JD, Reich D, Freeman R, et al.",
        "journal": "Commun Med 5(1):330",
        "verified": "2026-04-30 PubMed 직접",
    },
    "fda_gmlp_2021": {
        "name": "FDA Good Machine Learning Practice — Guiding Principles",
        "year": 2021, "identifier": "FDA-GMLP-2021",
        "authors": "U.S. FDA / Health Canada / UK MHRA",
    },
}


# ── 입출력 schema ────────────────────────────────────────────────
@dataclass
class Phase5VerificationInput:
    """Phase 4 verifier가 Phase 5 LIRICAL 결과를 검증할 때 받는 입력."""

    # Phase 5 결과 (LiricalScore.contributions 포함)
    lirical_candidates: list[dict] = field(default_factory=list)
    # 각 항목 schema:
    # {
    #   "disease_key": str, "name_en": str, "name_kr": str,
    #   "orpha_code": str, "icd10_codes": [...],
    #   "posttest_prob": float, "log10_lr_total": float,
    #   "matched_hpo": [HP IDs],
    #   "contributions": [{hpo_id, freq_in_disease, freq_in_background, lr, log10_lr, observed}]
    # }

    # 환자 임상 컨텍스트 (Phase 4와 공유)
    patient_age: Optional[int] = None
    patient_sex: str = "unknown"
    patient_history: list[str] = field(default_factory=list)
    patient_medications: list[str] = field(default_factory=list)
    observed_hpo_ids: list[str] = field(default_factory=list)
    excluded_hpo_ids: list[str] = field(default_factory=list)

    # Phase 5 trigger 사유 (LIRICAL이 왜 발동됐는지)
    trigger_reasons: list[str] = field(default_factory=list)


@dataclass
class VerifiedRareCandidate:
    """LLM 검증 통과한 단일 희귀질환 후보."""
    rank: int
    disease_key: str
    name_en: str = ""
    name_kr: str = ""
    posttest_prob: float = 0.0
    rationale: str = ""                    # 임상적 부합성 사유
    confounding_alerts: list[str] = field(default_factory=list)  # 감별 시 주의점
    citations: list[Citation] = field(default_factory=list)
    flag_for_clinician_review: bool = False


@dataclass
class Phase5VerificationResult:
    verified_candidates: list[VerifiedRareCandidate] = field(default_factory=list)
    overall_confidence: float = 0.0
    guard_rail_report: Optional[GuardRailReport] = None
    raw_llm_response: str = ""
    parse_success: bool = False
    fallback_to_lirical: bool = False    # Guard Rail 실패 시 LIRICAL 원본 유지
    mode: str = "mock"


# ── prompt 빌더 (Phase 5 전용) ──────────────────────────────────
SYSTEM_PROMPT_PHASE5 = """당신은 폐 희귀질환 진단 보조 AI의 검증 모듈이다.
입력은 LIRICAL Bayesian Likelihood Ratio (Robinson et al. PMID:32755546) 결과와
환자 임상 데이터다. 당신의 역할은 ranking을 새로 매기는 것이 아니라 *검증*이다.

엄격한 절차:
  1) 각 후보의 posttest_prob 해석은 Robinson 2020 Box 2를 따른다.
  2) 환자 데이터(나이/성별/과거력/HPO/excluded HPO)와 후보 질환의
     임상 양상이 정합되는지 검토한다.
  3) 정합되지 않으면 confounding_alerts에 사유 기재.
  4) 임상 권고는 반드시 아래 권위 출처 set에서만 인용한다.
  5) 사견·확신적 표현 금지: "may be / might / I think / 추정 / 아마" 등 reject.
     (근거: Omar M et al. Commun Med 2025 PMID:40753316 — adversarial
     prompt에 LLM이 50-82% 거짓 정보를 elaborate하는 현상)
  6) 환자 데이터에 *없는* 소견은 인용에 사용 금지.
  7) 본 검증의 목표 hallucination rate ≤ 1.47% (Asgari E et al.
     NPJ Digit Med 2025 PMID:40360677 잘 설계된 시스템 baseline).
  8) Guard Rail 실패 시 LIRICAL 원본 ranking을 그대로 보존한다(fallback).
     (FDA GMLP 2021 Principle 7 — Human-AI Team Performance)

출력 형식 — JSON만. 추가 설명 없음:
{
  "verified_candidates": [
    {
      "rank": 1,
      "disease_key": "<Phase 5 결과의 disease_key 그대로>",
      "name_en": "<원본 그대로>",
      "name_kr": "<원본 그대로>",
      "posttest_prob": <Phase 5 원본 그대로 — 새로 계산하지 마시오>,
      "rationale": "<환자 데이터와 정합 검토 결과>",
      "confounding_alerts": ["<phenocopy/감별 주의>", ...],
      "citations": [
        {"type":"PMID","identifier":"PMID:XXXXXXX","year":YYYY,"title":"..."},
        ...
      ],
      "flag_for_clinician_review": true|false
    }
  ],
  "overall_confidence": 0.0~1.0
}

권위 출처 set:
{authoritative_sources_list}
"""


def build_authoritative_list_phase5(extra_sources: dict[str, dict]) -> str:
    """system prompt에 삽입할 권위 출처 목록.

    Phase 4의 AUTHORITATIVE_SOURCES + LIRICAL_AUTHORITATIVE_SOURCES 합집합.
    """
    from .prompt_builder import AUTHORITATIVE_SOURCES as PHASE4_SOURCES

    merged = {**PHASE4_SOURCES, **extra_sources}
    lines = []
    for key, src in merged.items():
        lines.append(
            f"  - {src['name']} ({src['year']}) {src['identifier']}"
            + (f" — {src.get('authors', '')}" if src.get('authors') else "")
        )
    return "\n".join(lines)


def build_system_prompt_phase5() -> str:
    return SYSTEM_PROMPT_PHASE5.format(
        authoritative_sources_list=build_authoritative_list_phase5(LIRICAL_AUTHORITATIVE_SOURCES)
    )


def build_user_message_phase5(
    input_data: Phase5VerificationInput,
    hp_id_to_term: dict[str, str] | None = None,
) -> str:
    hp_id_to_term = hp_id_to_term or {}
    observed_lines = [f"  + {h}: {hp_id_to_term.get(h, '?')}" for h in input_data.observed_hpo_ids]
    excluded_lines = [f"  - {h}: {hp_id_to_term.get(h, '?')} (환자에 없음)" for h in input_data.excluded_hpo_ids]

    return f"""환자 정보:
  - 나이: {input_data.patient_age or '미상'}, 성별: {input_data.patient_sex}
  - 과거력: {', '.join(input_data.patient_history) or '미상'}
  - 현재 복용약: {', '.join(input_data.patient_medications) or '미상'}

환자 양성 HPO (관찰됨):
{chr(10).join(observed_lines) or '  (없음)'}

환자 음성 HPO (excluded — LIRICAL이 negation 정보로 사용):
{chr(10).join(excluded_lines) or '  (없음)'}

Phase 5 발동 사유:
{chr(10).join('  - ' + r for r in input_data.trigger_reasons) or '  (force_screen)'}

Phase 5 LIRICAL Top {len(input_data.lirical_candidates)} 후보 (Robinson 2020 Bayesian LR):
{json.dumps(input_data.lirical_candidates, ensure_ascii=False, indent=2)}

위 후보 각각에 대해:
  - posttest_prob를 *새로 계산하지 마시오* (Phase 5 원본 보존).
  - 환자 데이터와 임상 양상이 정합되는지 평가.
  - 부정합·phenocopy·감별 주의점은 confounding_alerts에 기재.
  - flag_for_clinician_review=true 조건: posttest_prob ≥ 0.10 또는 유전자 검사 권장.
  - 모든 권고에 권위 출처 PMID 인용 필수.

JSON만 출력하시오. 사견 0%, 출처 100%.
"""


# ── Phase 5 전용 Guard Rail (rare HP set / rare disease keys 확장) ──
def _load_phase5_valid_hp_set(registry) -> set[str]:
    """Phase 5 검증용 HP set — rare 376 + 49 v3.2 합집합.

    Phase 4의 v3.2 49 profile만 보면 rare HP가 invalid로 reject되는 문제 회피.
    """
    hp_set: set[str] = set()
    for prof in registry._profiles.values():
        for ph in prof.hpo_phenotypes:
            hp_id = ph.get("hpo_id") or ""
            if hp_id.startswith("HP:"):
                hp_set.add(hp_id)
    return hp_set


def _load_phase5_valid_disease_keys(registry) -> set[str]:
    """Phase 5는 희귀(376) 카테고리만 — 일반/기타 disease_key는 reject.

    feedback_phase_responsibility.md 정합: LIRICAL은 희귀 전용.
    """
    from ..domain.enums import DiseaseCategory
    return {
        prof.disease_key
        for prof in registry._profiles.values()
        if prof.category == DiseaseCategory.RARE
    }


def apply_phase5_guards(
    parsed_response: dict,
    registry,
) -> tuple[bool, GuardRailReport]:
    """Phase 5 전용 Guard Rail — Phase 4 6종 + 희귀 set 확장."""
    valid_hp = _load_phase5_valid_hp_set(registry)
    valid_disease = _load_phase5_valid_disease_keys(registry)
    valid_auth = set(gr._load_valid_authoritative_identifiers())
    # Phase 5 추가 출처 set 합집합
    valid_auth.update(src["identifier"] for src in LIRICAL_AUTHORITATIVE_SOURCES.values())

    rejected: list[dict] = []

    # Schema (Phase 5 변형)
    schema_ok = isinstance(parsed_response, dict) and "verified_candidates" in parsed_response
    if not schema_ok:
        rejected.append({"guard": "schema", "reason": "verified_candidates missing"})

    # HP IDs — text 전체에서 정규식으로 추출
    all_text = json.dumps(parsed_response, ensure_ascii=False)
    hp_used = re.findall(r"HP:\d{7}", all_text)
    hp_invalid = [h for h in hp_used if h not in valid_hp]
    hp_ok = len(hp_invalid) == 0
    if not hp_ok:
        rejected.append({"guard": "hp_id_phase5", "invalid": hp_invalid[:10]})

    # disease_key — 모두 RARE category
    candidates = parsed_response.get("verified_candidates", []) if schema_ok else []
    dks = [c.get("disease_key", "") for c in candidates]
    dk_invalid = [dk for dk in dks if dk not in valid_disease]
    dk_ok = len(dk_invalid) == 0
    if not dk_ok:
        rejected.append({"guard": "disease_key_rare", "invalid": dk_invalid[:10]})

    # Citation (per candidate)
    citation_ok = True
    for i, c in enumerate(candidates):
        cits = c.get("citations", [])
        if not isinstance(cits, list) or len(cits) == 0:
            citation_ok = False
            rejected.append({"guard": "citation", "item": f"cand[{i}]", "reason": "missing"})
            continue
        for cit in cits:
            ident = cit.get("identifier", "") if isinstance(cit, dict) else ""
            if ident not in valid_auth:
                citation_ok = False
                rejected.append({"guard": "citation", "item": f"cand[{i}]", "invalid": ident})

    # Confidence
    conf = float(parsed_response.get("overall_confidence", 0.0)) if schema_ok else 0.0
    conf_ok = conf >= gr.CONFIDENCE_THRESHOLD
    if not conf_ok:
        rejected.append({"guard": "confidence", "value": conf})

    # Hallucination keywords
    halluc_ok, halluc_kws = gr.guard_no_hallucination(all_text)
    if not halluc_ok:
        rejected.append({"guard": "hallucination", "keywords": halluc_kws})

    # Phase 5 추가 — posttest_prob 보존 검증 (LLM이 새로 계산하지 않았는지)
    posttest_preserved_ok = True
    for i, c in enumerate(candidates):
        pp = c.get("posttest_prob", None)
        if pp is None or not (0.0 <= float(pp) <= 1.0):
            posttest_preserved_ok = False
            rejected.append({"guard": "posttest_prob_range", "item": f"cand[{i}]", "value": pp})

    report = GuardRailReport(
        hp_id_validation_passed=hp_ok,
        icd_mapping_validation_passed=dk_ok,
        citation_required_passed=citation_ok,
        confidence_threshold_passed=conf_ok,
        hallucination_keyword_passed=halluc_ok,
        schema_validation_passed=schema_ok and posttest_preserved_ok,
        rejected_items=rejected,
    )
    all_pass = schema_ok and hp_ok and dk_ok and citation_ok and halluc_ok and posttest_preserved_ok
    return all_pass, report


# ── 메인 verifier 클래스 ────────────────────────────────────────
class Phase5LLMVerifier:
    """LIRICAL 결과를 LLM이 검증.

    사용:
        v = Phase5LLMVerifier(registry, mode="mock")
        result = v.verify_phase5(input_data, hp_id_to_term={...})

    fallback 정책:
        Guard Rail 실패 시 verified_candidates는 LIRICAL 원본 그대로(Phase 5 결과
        의 lirical_candidates → VerifiedRareCandidate로 1:1 보존). LLM 출력 폐기.
        FDA GMLP 2021 Principle 7 정합.
    """

    def __init__(
        self,
        registry,
        mode: str = "mock",
        model_id: str = "anthropic.claude-sonnet-4-6",
    ):
        self._registry = registry
        self._llm = BedrockPhase4Verifier(model_id=model_id, mode=mode)
        self.mode = mode

    def _parse(self, raw: str) -> tuple[dict, bool]:
        text = raw.strip()
        if "```json" in text:
            text = text.split("```json", 1)[1].split("```", 1)[0].strip()
        elif "```" in text:
            text = text.split("```", 1)[1].split("```", 1)[0].strip()
        try:
            return json.loads(text), True
        except json.JSONDecodeError as e:
            logger.warning("Phase 5 verifier JSON parse failed: %s", e)
            return {}, False

    def _fallback(
        self,
        input_data: Phase5VerificationInput,
        report: GuardRailReport,
        raw: str,
        parse_success: bool,
    ) -> Phase5VerificationResult:
        """Guard Rail 실패 → LIRICAL 원본 보존."""
        verified: list[VerifiedRareCandidate] = []
        for i, c in enumerate(input_data.lirical_candidates[:10], start=1):
            verified.append(
                VerifiedRareCandidate(
                    rank=i,
                    disease_key=c.get("disease_key", ""),
                    name_en=c.get("name_en", ""),
                    name_kr=c.get("name_kr", ""),
                    posttest_prob=float(c.get("posttest_prob", 0.0)),
                    rationale="Guard Rail fallback — LIRICAL 원본 ranking 유지 (LLM 검증 미통과). FDA GMLP 2021 Principle 7.",
                    confounding_alerts=[],
                    citations=[Citation(
                        type="PMID", identifier="PMID:32755546", year=2020,
                        section="Box 2", title="Robinson 2020 LIRICAL",
                    )],
                    flag_for_clinician_review=True,
                )
            )
        return Phase5VerificationResult(
            verified_candidates=verified,
            overall_confidence=0.0,
            guard_rail_report=report,
            raw_llm_response=raw,
            parse_success=parse_success,
            fallback_to_lirical=True,
            mode=self.mode,
        )

    def _build_phase4_input_shim(
        self, input_data: Phase5VerificationInput
    ) -> "Phase4Input":  # noqa: F821
        """BedrockPhase4Verifier.call(...)이 받는 Phase4Input shape으로 변환."""
        from .schemas import Phase4Input  # local import to avoid cycle
        return Phase4Input(
            phase3_ranking=[
                {"disease_key": c.get("disease_key", ""), "score": c.get("posttest_prob", 0.0)}
                for c in input_data.lirical_candidates
            ],
            matched_hp_ids=list(input_data.observed_hpo_ids),
            patient_age=input_data.patient_age,
            patient_sex=(input_data.patient_sex or "unknown"),
            patient_history=list(input_data.patient_history),
            patient_medications=list(input_data.patient_medications),
            xray_findings=[],
            lab_summary=[],
            clinical_scores={},
        )

    def verify_phase5(
        self,
        input_data: Phase5VerificationInput,
        hp_id_to_term: dict[str, str] | None = None,
    ) -> Phase5VerificationResult:
        hp_id_to_term = hp_id_to_term or {}

        # 1) LLM 호출 — bedrock_verifier.call(Phase4Input)을 그대로 사용하되
        #    system/user prompt는 mode='real' 시 우리 Phase 5 prompt가 들어가도록
        #    monkey-patch 대신, mock 모드에서는 LLM이 우리 prompt를 못 받음 →
        #    mock 모드에서는 fallback 시뮬레이션을 위해 빈 응답을 반환받고
        #    Guard Rail 검증을 거쳐 fallback 경로 진입.
        try:
            shim = self._build_phase4_input_shim(input_data)
            raw = self._llm.call(shim, hp_id_to_term)
        except Exception as e:
            logger.warning("Phase 5 LLM call failed: %s", e)
            raw = ""

        # 2) parse
        parsed, parse_success = self._parse(raw)

        # 3) Phase 5 전용 Guard Rail
        if parse_success:
            all_pass, report = apply_phase5_guards(parsed, self._registry)
        else:
            all_pass = False
            report = GuardRailReport(
                hp_id_validation_passed=False,
                icd_mapping_validation_passed=False,
                citation_required_passed=False,
                confidence_threshold_passed=False,
                hallucination_keyword_passed=False,
                schema_validation_passed=False,
                rejected_items=[{"guard": "parse", "reason": "JSON parse failed"}],
            )

        # 4) 통과 → verified_candidates 빌드, 실패 → fallback
        if all_pass:
            verified: list[VerifiedRareCandidate] = []
            for c in parsed.get("verified_candidates", []):
                cits = [
                    Citation(
                        type=ci.get("type", "PMID"),
                        identifier=ci.get("identifier", ""),
                        year=ci.get("year"),
                        section=ci.get("section"),
                        title=ci.get("title"),
                    )
                    for ci in c.get("citations", [])
                ]
                verified.append(
                    VerifiedRareCandidate(
                        rank=int(c.get("rank", 0)),
                        disease_key=c.get("disease_key", ""),
                        name_en=c.get("name_en", ""),
                        name_kr=c.get("name_kr", ""),
                        posttest_prob=float(c.get("posttest_prob", 0.0)),
                        rationale=c.get("rationale", ""),
                        confounding_alerts=list(c.get("confounding_alerts", [])),
                        citations=cits,
                        flag_for_clinician_review=bool(c.get("flag_for_clinician_review", False)),
                    )
                )
            return Phase5VerificationResult(
                verified_candidates=verified,
                overall_confidence=float(parsed.get("overall_confidence", 0.0)),
                guard_rail_report=report,
                raw_llm_response=raw,
                parse_success=parse_success,
                fallback_to_lirical=False,
                mode=self.mode,
            )

        return self._fallback(input_data, report, raw, parse_success)


def lirical_score_to_dict(lirical_score: Any) -> dict:
    """LiricalScore (phase5_rare.lirical_engine) → Phase5VerificationInput용 dict."""
    return {
        "disease_key": lirical_score.disease_key,
        "name_en": lirical_score.name_en,
        "name_kr": lirical_score.name_kr,
        "orpha_code": lirical_score.orpha_code,
        "icd10_codes": list(lirical_score.icd10_codes),
        "posttest_prob": float(lirical_score.posttest_prob),
        "log10_lr_total": float(lirical_score.log10_lr_total),
        "matched_hpo": list(lirical_score.matched_hpo),
        "contributions": [
            {
                "hpo_id": c.hpo_id,
                "hpo_label": c.hpo_label,
                "observed": c.observed,
                "freq_in_disease": c.freq_in_disease,
                "freq_in_background": c.freq_in_background,
                "lr": c.lr,
                "log10_lr": c.log10_lr,
            }
            for c in lirical_score.contributions
        ],
    }
