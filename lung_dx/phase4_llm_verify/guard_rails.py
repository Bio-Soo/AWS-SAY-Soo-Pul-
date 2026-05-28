"""Phase 4 Guard Rail 6종 — 사견·환각·게으름 차단.

Guard Rail:
  ① HP ID 한정 set (170) 외 reject
  ② ICD-10 WHO 표준 매핑 검증
  ③ 가이드라인 인용 강제 (모든 진단/권고)
  ④ Confidence ≥ 0.7 (또는 의료진 검토 flag)
  ⑤ 사견·환각 키워드 detect
  ⑥ Schema validation
"""
from __future__ import annotations

import re
import json
from pathlib import Path
import yaml

from ..config import paths
from .prompt_builder import AUTHORITATIVE_SOURCES
from .schemas import RevisedDiseaseRanking, MissedDiagnosisAlert, GuardRailReport, Citation


# Guard ⑤ 사견·환각 키워드 (의학 정확성 위배)
HALLUCINATION_KEYWORDS = [
    # 영문
    r'\bmay be\b', r'\bmight\b', r'\bpossibly\b', r'\blikely\b', r'\bperhaps\b',
    r'\bI think\b', r'\bI believe\b', r'\bin my opinion\b', r'\bseems\b',
    r'\bprobably\b',
    # 한글
    '추정', '아마', '아마도', '제가 보기에', '제 의견',
]

# Guard ④ Confidence threshold (FDA 510(k) 보조진단 표준)
CONFIDENCE_THRESHOLD = 0.7


def _load_valid_hp_set() -> set[str]:
    """v3.2 audited 170 HP IDs."""
    profiles = yaml.safe_load(open(paths.DISEASE_PROFILES_YAML))
    hp_set = set()
    for p in profiles.values():
        for ph in p.get('hpo_phenotypes', []):
            hp_set.add(ph['hpo_id'])
    return hp_set


def _load_valid_disease_keys() -> set[str]:
    """v3.2 49 profile keys."""
    profiles = yaml.safe_load(open(paths.DISEASE_PROFILES_YAML))
    return set(profiles.keys())


def _load_valid_authoritative_identifiers() -> set[str]:
    """권위 출처 identifier set (PMID/ISBN/가이드라인 명)."""
    ids = set()
    for src in AUTHORITATIVE_SOURCES.values():
        ids.add(src['identifier'])
    return ids


# ── Guard ① HP ID 한정 set 검증 ──────────────────────────────
def guard_hp_id(hp_ids: list[str], valid_set: set[str]) -> tuple[bool, list[str]]:
    """HP ID가 v3.2 audited 170 set 내에 있는지."""
    invalid = [hp for hp in hp_ids if hp not in valid_set]
    return (len(invalid) == 0, invalid)


# ── Guard ② ICD-10 / disease_key 매핑 검증 ────────────────────
def guard_disease_key(disease_keys: list[str], valid_set: set[str]) -> tuple[bool, list[str]]:
    """disease_key가 v3.2 49 profile에 있는지."""
    invalid = [dk for dk in disease_keys if dk not in valid_set]
    return (len(invalid) == 0, invalid)


# ── Guard ③ 가이드라인 인용 강제 ──────────────────────────────
def guard_citation(citations: list[dict], authoritative_ids: set[str]) -> tuple[bool, list[dict]]:
    """모든 인용이 권위 출처 set 내인지."""
    if not citations:
        return False, [{'reason': 'no citation provided'}]
    invalid = []
    for c in citations:
        identifier = c.get('identifier', '') if isinstance(c, dict) else getattr(c, 'identifier', '')
        if identifier not in authoritative_ids:
            invalid.append({'identifier': identifier, 'reason': 'not in authoritative set'})
    return (len(invalid) == 0, invalid)


def guard_citation_present(item: dict) -> bool:
    """단일 진단/alert 항목에 citation이 있는지."""
    cits = item.get('citations', [])
    return isinstance(cits, list) and len(cits) > 0


# ── Guard ④ Confidence threshold ─────────────────────────────
def guard_confidence(confidence: float, threshold: float = CONFIDENCE_THRESHOLD
                     ) -> tuple[bool, str]:
    """Confidence가 threshold 이상인지."""
    if confidence >= threshold:
        return True, ''
    return False, f'confidence {confidence:.2f} < {threshold} — 의료진 검토 필요'


# ── Guard ⑤ 사견·환각 키워드 detect ──────────────────────────
def guard_no_hallucination(text: str) -> tuple[bool, list[str]]:
    """텍스트에 사견·환각 키워드 부재 검증."""
    found = []
    for kw in HALLUCINATION_KEYWORDS:
        if re.search(kw, text, re.IGNORECASE):
            found.append(kw)
    return (len(found) == 0, found)


# ── Guard ⑥ Schema validation ────────────────────────────────
def guard_schema(parsed: dict) -> tuple[bool, list[str]]:
    """LLM JSON 응답이 expected schema 만족하는지."""
    errors = []
    if not isinstance(parsed, dict):
        return False, ['root not dict']

    if 'revised_ranking' not in parsed or not isinstance(parsed['revised_ranking'], list):
        errors.append('revised_ranking missing or not list')
    if 'missed_alerts' not in parsed:
        parsed['missed_alerts'] = []   # optional
    if 'overall_confidence' not in parsed:
        errors.append('overall_confidence missing')

    # Each ranking item must have required fields
    for i, item in enumerate(parsed.get('revised_ranking', [])):
        for f in ['rank', 'disease_key', 'score', 'rationale']:
            if f not in item:
                errors.append(f'ranking[{i}].{f} missing')

    return (len(errors) == 0, errors)


# ── 통합 적용 함수 ───────────────────────────────────────────
def apply_all_guards(
    parsed_response: dict,
    overall_confidence: float | None = None,
) -> tuple[bool, GuardRailReport]:
    """모든 Guard Rail 적용. fallback 결정."""
    valid_hp = _load_valid_hp_set()
    valid_disease = _load_valid_disease_keys()
    valid_auth = _load_valid_authoritative_identifiers()

    rejected = []

    # ⑥ Schema first (다른 guard의 전제)
    schema_ok, schema_errors = guard_schema(parsed_response)
    if not schema_ok:
        rejected.append({'guard': 'schema', 'errors': schema_errors})

    # ① HP IDs (rationale·citation 텍스트에서 추출)
    all_text = json.dumps(parsed_response, ensure_ascii=False)
    hp_pattern = r'HP:\d{7}'
    hp_used = re.findall(hp_pattern, all_text)
    hp_ok, hp_invalid = guard_hp_id(hp_used, valid_hp)
    if not hp_ok:
        rejected.append({'guard': 'hp_id', 'invalid': hp_invalid})

    # ② disease_key
    if schema_ok:
        dks = [it.get('disease_key', '') for it in parsed_response.get('revised_ranking', [])]
        dk_ok, dk_invalid = guard_disease_key(dks, valid_disease)
        if not dk_ok:
            rejected.append({'guard': 'disease_key', 'invalid': dk_invalid})
    else:
        dk_ok = False

    # ③ Citation per ranking item
    citation_ok = True
    if schema_ok:
        for i, item in enumerate(parsed_response.get('revised_ranking', [])):
            if not guard_citation_present(item):
                citation_ok = False
                rejected.append({'guard': 'citation', 'item': f'ranking[{i}]', 'reason': 'no citation'})
            else:
                ok, inv = guard_citation(item.get('citations', []), valid_auth)
                if not ok:
                    citation_ok = False
                    rejected.append({'guard': 'citation', 'item': f'ranking[{i}]', 'invalid': inv})

    # ④ Confidence
    conf = overall_confidence if overall_confidence is not None else parsed_response.get('overall_confidence', 0.0)
    conf_ok, conf_msg = guard_confidence(conf)
    if not conf_ok:
        rejected.append({'guard': 'confidence', 'value': conf, 'msg': conf_msg})

    # ⑤ Hallucination
    halluc_ok, halluc_kws = guard_no_hallucination(all_text)
    if not halluc_ok:
        rejected.append({'guard': 'hallucination', 'keywords': halluc_kws})

    report = GuardRailReport(
        hp_id_validation_passed=hp_ok,
        icd_mapping_validation_passed=dk_ok,
        citation_required_passed=citation_ok,
        confidence_threshold_passed=conf_ok,
        hallucination_keyword_passed=halluc_ok,
        schema_validation_passed=schema_ok,
        rejected_items=rejected,
    )

    # All-pass 정의: schema + hp + disease_key + citation 통과 (confidence/hallucination은 flag)
    # — confidence 미달은 의료진 검토 권고이지만 fallback X
    # — hallucination은 검출 시 fallback (의학 정확성 위배)
    all_pass = schema_ok and hp_ok and dk_ok and citation_ok and halluc_ok
    return all_pass, report
