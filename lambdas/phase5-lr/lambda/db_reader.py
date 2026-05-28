"""Phase 5 LR DB Reader — phase1/phase2/lab raw 읽기 + Step 0 HPO 정규화.

Source → modality 매핑:
  phase1 positive/negative_hpo (history) → symptoms
  phase2 xray_hpo_inferred             → radiology
  lab_result.abnormal_flag != Normal   → lab (best-effort HPO 변환)

Lab → HPO 변환은 LAB_HPO_MAP (LOINC → HPO) 에 있는 것만. 매핑 없으면 skip.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


class DBReader:
    """Aurora 에서 환자 HPO 데이터 수집 + Step 0 정규화."""

    # LOINC → HPO 매핑 (best-effort). 매핑 없으면 skip.
    # TODO: 별도 yaml 로 관리 권장. 일단 인라인 — 권미라님/박성수님이 확장.
    LAB_HPO_MAP: dict[str, str] = {
        # 예시 (실제 매핑 필요):
        # "2160-0": "HP:0003259",   # Creatinine elevated → Elevated serum creatinine
        # "1742-6": "HP:0001394",   # ALT elevated → Cirrhosis (placeholder)
    }

    def __init__(self, get_conn_fn):
        self.get_conn_fn = get_conn_fn

    def read_patient_hpos(self, session_id: str):
        """환자 HPO 데이터 + Step 0 결과 반환.

        Returns:
            patient_hpos:    {hpo_id: {modality, source, state, confidence}}
            audit_trail:     List[{hpo_id, source, source_modality, state, ...}]
            step0_log:       {ok, error, lab_converted, micro_converted,
                              patient_hpo_count, source_breakdown}
            input_hpo_used:  {phase1_positive, phase1_negative, phase2_xray}
        """
        conn = self.get_conn_fn()
        if conn is None:
            raise RuntimeError("DB connection failed (Secrets Manager / VPC 확인 필요)")

        patient_hpos: dict = {}
        audit_trail: list = []
        input_hpo_used = {
            "phase1_positive": [],
            "phase1_negative": [],
            "phase2_xray": [],
        }
        source_breakdown = {"history": 0, "xray": 0, "lab": 0, "micro": 0}
        lab_converted = 0
        error_msg: str | None = None

        try:
            cur = conn.cursor()

            # ── 1) Phase 1 (history HPO) ─────────────────────────────
            cur.execute(
                """
                SELECT positive_hpo, negative_hpo
                FROM phase1_hpo_extraction
                WHERE session_id=%s
                ORDER BY executed_at DESC LIMIT 1
                """,
                (session_id,),
            )
            row = cur.fetchone()
            if row:
                positive_hpo, negative_hpo = row
                # phase1 positive: list[str] (new schema) | list[dict] (legacy) 둘 다 처리
                for item in (positive_hpo or []):
                    if isinstance(item, str):
                        hp, label, confidence = item, "", 1.0
                    elif isinstance(item, dict):
                        hp = item.get("hpo_id") or item.get("hpo")
                        label = item.get("label") or item.get("official_term") or ""
                        confidence = item.get("confidence", 1.0)
                    else:
                        continue
                    if not hp:
                        continue
                    patient_hpos[hp] = {
                        "modality": "symptoms",
                        "source": "history",
                        "state": "positive",
                        "confidence": confidence,
                    }
                    input_hpo_used["phase1_positive"].append(
                        {"hpo": hp, "label": label, "confidence": confidence}
                    )
                    audit_trail.append({
                        "hpo_id": hp, "source": "history",
                        "source_modality": "symptoms",
                        "state": "positive", "category": "phase1",
                    })
                    source_breakdown["history"] += 1

                # phase1 negative: 같은 패턴
                for item in (negative_hpo or []):
                    if isinstance(item, str):
                        hp, label, confidence = item, "", 1.0
                    elif isinstance(item, dict):
                        hp = item.get("hpo_id") or item.get("hpo")
                        label = item.get("label") or item.get("official_term") or ""
                        confidence = item.get("confidence", 1.0)
                    else:
                        continue
                    if not hp:
                        continue
                    patient_hpos[hp] = {
                        "modality": "symptoms",
                        "source": "history",
                        "state": "negative",
                        "confidence": confidence,
                    }
                    input_hpo_used["phase1_negative"].append(
                        {"hpo": hp, "label": label}
                    )
                    audit_trail.append({
                        "hpo_id": hp, "source": "history",
                        "source_modality": "symptoms",
                        "state": "negative", "category": "phase1",
                    })

            # ── 2) Phase 2 (xray HPO) ─────────────────────────────────
            cur.execute(
                """
                SELECT xray_hpo_inferred, study_id
                FROM phase2_xray_processing
                WHERE session_id=%s
                ORDER BY executed_at DESC LIMIT 1
                """,
                (session_id,),
            )
            row = cur.fetchone()
            if row:
                xray_hpo, study_id = row
                # xray_hpo 형식: list[dict] (legacy) | {"positive_hpos":[str list], "xray_detail":{...}} (new)
                if isinstance(xray_hpo, dict):
                    pos_list = xray_hpo.get("positive_hpos") or []
                    detail = xray_hpo.get("xray_detail") or {}
                    iter_items = [
                        {"hpo_id": hid,
                         "label": (detail.get(k, [None, None])[0]
                                   if isinstance(detail, dict) else ""),
                         "probability": (detail.get(k, [0, None])[0]
                                         if isinstance(detail, dict) else 1.0)}
                        for hid in pos_list
                        for k in [next((kk for kk, v in (detail.items() if isinstance(detail, dict) else [])
                                        if isinstance(v, (list,tuple)) and len(v) >= 2 and v[1] == hid), '')]
                    ]
                else:
                    iter_items = xray_hpo or []
                for item in iter_items:
                    if isinstance(item, str):
                        hp, label, probability = item, "", 1.0
                    elif isinstance(item, dict):
                        hp = item.get("hpo_id") or item.get("hpo")
                        label = item.get("label") or item.get("finding") or ""
                        probability = item.get("probability", item.get("confidence", 1.0))
                    else:
                        continue
                    if not hp:
                        continue
                    # phase2 가 phase1 positive 와 중복돼도 radiology 가 우선
                    patient_hpos[hp] = {
                        "modality": "radiology",
                        "source": "xray",
                        "state": "positive",
                        "confidence": probability,
                    }
                    input_hpo_used["phase2_xray"].append(
                        {"hpo": hp, "label": label, "confidence": probability}
                    )
                    audit_trail.append({
                        "hpo_id": hp, "source": "xray",
                        "source_modality": "radiology",
                        "study_id": str(study_id) if study_id else None,
                        "state": "positive", "category": "phase2",
                    })
                    source_breakdown["xray"] += 1

            # ── 3) Lab raw (best-effort HPO 변환) ────────────────────
            cur.execute(
                """
                SELECT lr.loinc_code, lr.value_numeric, lr.abnormal_flag, lr.test_name_en
                FROM lab_result lr
                INNER JOIN diagnosis_session ds ON lr.patient_id = ds.patient_id
                WHERE ds.session_id=%s
                  AND lr.abnormal_flag IS NOT NULL
                  AND lr.abnormal_flag NOT IN ('N', 'Normal', '')
                """,
                (session_id,),
            )
            for loinc, value, flag, name in cur.fetchall():
                if not loinc:
                    continue
                hp = self.LAB_HPO_MAP.get(loinc)
                if not hp:
                    continue  # best-effort: 매핑 없으면 skip
                # 이미 phase1/2 에서 잡혔으면 덮어쓰지 않음
                if hp not in patient_hpos:
                    patient_hpos[hp] = {
                        "modality": "lab",
                        "source": "lab",
                        "state": "positive",
                        "confidence": 1.0,
                        "lab_value": float(value) if value is not None else None,
                    }
                    source_breakdown["lab"] += 1
                audit_trail.append({
                    "hpo_id": hp, "source": "lab", "source_modality": "lab",
                    "itemid": f"loinc:{loinc}",
                    "value": float(value) if value is not None else None,
                    "abnormal_flag": flag, "state": "positive",
                    "category": "lab_converted",
                })
                lab_converted += 1

        except Exception as e:
            logger.exception("DB read failed")
            error_msg = str(e)[:500]
        finally:
            conn.close()

        step0_log = {
            "ok": error_msg is None,
            "error": error_msg,
            "lab_converted": lab_converted,
            "micro_converted": 0,
            "patient_hpo_count": len(patient_hpos),
            "source_breakdown": source_breakdown,
        }

        return patient_hpos, audit_trail, step0_log, input_hpo_used
