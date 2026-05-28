"""Phase 5 LR Engine — LIRICAL Likelihood Ratio scoring.

근거:
  - Robinson PN et al. Am J Hum Genet 2020;107(3):403-417 (PMID:32755546)
  - LR_pipeline_v2.docx (권미라 v3.1) 카테고리 A~G 가중치
  - rare_disease_profiles_v3_1.yaml (KB)
  - hpo_background_freq.json (HPOA marginal frequency, denominator)

Algorithm:
  For each disease D:
    matched = D.hpo_symptoms ∩ patient_hpos (by hpo_id)
    For each matched HP, by source modality (radiology/symptoms/lab/micro):
        lr(HP|D)   = frequency_p(HP|D) / background_freq(HP)
        log_lr     = log10(lr)
    weighted_log_lr = Σ weights[mod] × Σ log_lr_mod    (weights from lr_category A~G)
    log_prior       = log10(prevalence_numeric)
    final_score     = weighted_log_lr + log_prior
    relative_risk   = exp(final_score)
    if relative_risk > 5.0: include in listed_diseases
"""
from __future__ import annotations

import json
import logging
import math

import yaml

logger = logging.getLogger(__name__)

LR_THRESHOLD = 5.0
SMOOTHING_FLOOR_DEFAULT = 1e-5


def load_background_freq(path: str) -> dict:
    """hpo_background_freq.json → {hp_id: freq in [0,1]}."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_rare_disease_kb(path: str) -> tuple[dict, str]:
    """rare_disease_profiles_v3_1.yaml → (rare_diseases dict, version label)."""
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    rare_diseases = data.get("rare_diseases", {}) or {}
    version = data.get("metadata", {}).get("version", "unknown")
    return rare_diseases, f"rare_disease_profiles_v{version}"


class LIRICALEngine:
    """LIRICAL-style LR scoring against rare disease KB."""

    def __init__(self, background_freq: dict, rare_diseases_kb: dict,
                 floor: float = SMOOTHING_FLOOR_DEFAULT):
        self.bg_freq = background_freq
        self.kb = rare_diseases_kb
        self.floor = floor

    def score_all(self, patient_hpos: dict) -> list[dict]:
        """모든 질환 대상 LR 계산 → LR > LR_THRESHOLD 만 정렬해 반환.

        Args:
            patient_hpos: {hpo_id: {modality, source, state, confidence, ...}}
                          modality ∈ {radiology, symptoms, lab, micro}
                          source   ∈ {history, xray, lab, micro}
                          state    ∈ {positive, negative}
        Returns:
            List[dict] — listed_diseases JSONB 형식 (LR 내림차순)
        """
        listed = []
        patient_hpo_ids = set(patient_hpos.keys())
        negative_hpo_ids = {
            hp for hp, meta in patient_hpos.items() if meta.get("state") == "negative"
        }

        for key, disease in self.kb.items():
            try:
                result = self._score_one(
                    key, disease, patient_hpos, patient_hpo_ids, negative_hpo_ids
                )
            except Exception as e:
                logger.warning("disease %s scoring failed: %s", key, e)
                continue
            if result and result["lr_value"] > LR_THRESHOLD:
                listed.append(result)

        listed.sort(key=lambda d: d["lr_value"], reverse=True)
        return listed

    # ────────────────────────────────────────────────────────────
    def _score_one(self, key, disease, patient_hpos, patient_hpo_ids, negative_hpo_ids):
        disease_hpos = disease.get("hpo_symptoms", []) or []
        if not disease_hpos:
            return None

        lr_weights = disease.get("lr_weights", {}) or {}
        category = disease.get("lr_category", "G")
        prevalence_numeric = disease.get("prevalence_numeric", 1e-5) or 1e-5

        log_lr_by_mod = {"radiology": 0.0, "symptoms": 0.0, "lab": 0.0, "micro": 0.0}
        matched_by_mod = {"phase1": [], "phase2": [], "lab": []}
        contradicted = []

        for d_hp in disease_hpos:
            hp_id = d_hp.get("hpo_id")
            if not hp_id:
                continue

            # 환자가 negative 로 표시 → contradiction
            if hp_id in negative_hpo_ids:
                contradicted.append({
                    "hpo_id": hp_id,
                    "name_en": d_hp.get("name_en"),
                    "expected_frequency_p": d_hp.get("frequency_p"),
                })
                continue

            # 환자 HPO 에 없으면 LR contribution 없음
            if hp_id not in patient_hpo_ids:
                continue

            # LR 계산
            freq_p = d_hp.get("frequency_p", 0.5) or 0.5
            bg = self.bg_freq.get(hp_id, self.floor)
            if not bg or bg <= 0:
                bg = self.floor
            try:
                log_lr = math.log10(freq_p / bg)
            except (ValueError, ZeroDivisionError):
                log_lr = 0.0

            patient_meta = patient_hpos.get(hp_id, {})
            modality = patient_meta.get("modality", "symptoms")
            source = patient_meta.get("source", "history")

            if modality in log_lr_by_mod:
                log_lr_by_mod[modality] += log_lr

            match_entry = {
                "hpo_id": hp_id,
                "name_en": d_hp.get("name_en"),
                "frequency_p": freq_p,
                "background_freq": round(bg, 8),
                "log_lr": round(log_lr, 4),
            }
            if source == "history":
                matched_by_mod["phase1"].append(match_entry)
            elif source == "xray":
                matched_by_mod["phase2"].append(match_entry)
            elif source == "lab":
                matched_by_mod["lab"].append(match_entry)

        total_matched = sum(len(v) for v in matched_by_mod.values())
        if total_matched == 0:
            return None

        # 가중 합산 (weights 의 modality 만 사용)
        weighted_log_lr = 0.0
        for mod, weight in lr_weights.items():
            if mod in log_lr_by_mod:
                weighted_log_lr += float(weight) * log_lr_by_mod[mod]

        # Prior bonus
        try:
            log_prior = math.log10(prevalence_numeric) if prevalence_numeric > 0 else -10
        except (ValueError, TypeError):
            log_prior = -10

        final_score = weighted_log_lr + log_prior
        try:
            relative_risk = math.exp(final_score)
        except OverflowError:
            relative_risk = float("inf")

        return {
            "orphacode": str(disease.get("orphacode", "")),
            "disease_en": disease.get("disease_en", ""),
            "disease_kr": disease.get("disease_kr", ""),
            "icd10": disease.get("icd10", []) or [],
            "lr_value": round(relative_risk, 4),
            "lr_category": category,
            "matched_hpo_phase1": matched_by_mod["phase1"],
            "matched_hpo_phase2": matched_by_mod["phase2"],
            "matched_hpo_lab": matched_by_mod["lab"],
            "contradicted_hpo": contradicted,
            "weights_applied": {k: float(v) for k, v in lr_weights.items()},
            "evidence": {
                "log_lr_radiology": round(log_lr_by_mod["radiology"], 4),
                "log_lr_symptoms": round(log_lr_by_mod["symptoms"], 4),
                "log_lr_lab": round(log_lr_by_mod["lab"], 4),
                "log_lr_micro": round(log_lr_by_mod["micro"], 4),
                "weighted_log_lr": round(weighted_log_lr, 4),
                "log_prior": round(log_prior, 4),
                "final_score": round(final_score, 4),
            },
            "prevalence": disease.get("prevalence", ""),
            "prevalence_numeric": prevalence_numeric,
            "gene_associations": disease.get("gene_associations", []) or [],
            "inheritance": disease.get("inheritance", []) or [],
            "onset_age": disease.get("onset_age"),
            "organ_systems": disease.get("organ_systems", []) or [],
            "source": "rare_disease_profiles_v3_1",
        }
