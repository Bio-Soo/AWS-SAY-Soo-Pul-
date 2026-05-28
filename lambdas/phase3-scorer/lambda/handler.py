"""Phase 3 — Multimodal Weighted Scoring Lambda handler.

API Gateway proxy integration. Reads JSON body, constructs lung_dx dataclasses,
calls DiagnosticScorer.score_all(), serializes back to JSON.

Layers:
  - phase3-deps: /opt/python/lung_dx + 의존 패키지 (PyYAML, openpyxl)
  - phase3-data: /opt/data/*.yaml + *.xlsx

Environment:
  DATA_DIR     (default /opt/data)
  PYTHONPATH   (default /opt/python)
  LOG_LEVEL    (default INFO)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
import uuid
from dataclasses import asdict
from typing import Any

import boto3

try:
    import psycopg2
    from psycopg2.extras import Json as PgJson
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False

# ── PYTHONPATH 보완 (Layer가 /opt/python에 lung_dx 배치) ──────────
sys.path.insert(0, os.environ.get("PYTHONPATH", "/opt/python"))

from lung_dx.domain.findings import (  # noqa: E402
    LabFinding,
    MicroFinding,
    Phase2Result,
    RadiologyFinding,
    ScoringSystemResult,
    SymptomMatch,
    XrayPrediction,
)
# v3_6 lung_dx: Phase1Result 가 제거됨 (Phase 1 외부 팀 offload).
# 대신 Phase2Result 가 X-ray 결과 컨테이너 — 동일 fields (detected_findings,
# possible_findings, all_predictions, candidate_icd_codes, ...). score_all 의
# X-ray 인자는 phase2_result 로 명명됨.
from lung_dx.knowledge.disease_registry import DiseaseRegistry  # noqa: E402
from lung_dx.phase3_multimodal.diagnostic_scorer import DiagnosticScorer  # noqa: E402
from lung_dx.phase3_multimodal.symptom_matcher import SymptomMatcher  # noqa: E402

# ── Logger ──────────────────────────────────────────────────────
logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# ────────────────────────────────────────────────────────────────
# DB 연동 — phase_execution_log (상세) + diagnosis_session (상태)
# 참조: database/system-log-schema-ddl.sql, RAG/rag_llm_3.py 표준 패턴
# ────────────────────────────────────────────────────────────────
DB_HOST = "patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com"
DB_NAME = "soopul"
DB_USER = "app_user"
DB_SECRET_ID = "soopul/aurora/app-user"
DB_REGION = "ap-northeast-2"


def _get_db_conn():
    if not DB_AVAILABLE:
        return None
    try:
        sm = boto3.client("secretsmanager", region_name=DB_REGION)
        secret_str = sm.get_secret_value(SecretId=DB_SECRET_ID)["SecretString"]
        try:
            pwd = json.loads(secret_str)["password"]
        except (json.JSONDecodeError, KeyError, TypeError):
            pwd = secret_str
        return psycopg2.connect(
            host=DB_HOST, port=5432, database=DB_NAME, user=DB_USER, password=pwd,
            options="-c search_path=soopulai", connect_timeout=10,
        )
    except Exception as e:
        logger.warning("DB 연결 실패: %s", e)
        return None


def _classify_error(exc: Exception) -> str:
    name = type(exc).__name__
    if name in ("ValueError", "TypeError", "KeyError"):
        return "validation"
    if name in ("TimeoutError",) or "timeout" in str(exc).lower():
        return "infra"
    if "boto" in name.lower() or "ClientError" in name or "EndpointConnection" in name:
        return "external_api"
    if "torch" in str(exc).lower() or "cuda" in str(exc).lower():
        return "model"
    return "infra"


def _record_phase_log(
    session_id=None,
    patient_id=None,
    phase_name="phase3",
    phase_step="",
    status="started",
    started_at=None,
    input_summary=None,
    output_summary=None,
    error=None,
    lambda_request_id="",
    lambda_function="",
    model_versions=None,
):
    conn = _get_db_conn()
    if not conn:
        return None
    log_id = str(uuid.uuid4())
    try:
        cur = conn.cursor()
        error_code = error_message = error_stacktrace = error_category = None
        if error is not None:
            error_code = type(error).__name__.upper()[:64]
            error_message = str(error)[:8000]
            error_stacktrace = "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )[:16000]
            error_category = _classify_error(error)
        duration_ms = int((time.time() - started_at) * 1000) if started_at else None
        cur.execute(
            """
            INSERT INTO phase_execution_log (
                log_id, session_id, patient_id,
                phase_name, phase_step, status,
                started_at, completed_at, duration_ms,
                lambda_function, lambda_request_id,
                input_summary, output_summary,
                error_code, error_message, error_stacktrace, error_category,
                model_versions
            ) VALUES (
                %s, %s, %s,
                %s, %s, %s,
                COALESCE(to_timestamp(%s), NOW()), NOW(), %s,
                %s, %s,
                %s, %s,
                %s, %s, %s, %s,
                %s
            )
            """,
            (
                log_id, session_id, patient_id,
                phase_name, phase_step, status,
                started_at, duration_ms,
                lambda_function, lambda_request_id,
                PgJson(input_summary) if input_summary else None,
                PgJson(output_summary) if output_summary else None,
                error_code, error_message, error_stacktrace, error_category,
                PgJson(model_versions) if model_versions else None,
            ),
        )
        conn.commit()
        return log_id
    except Exception as e:
        logger.warning("phase_execution_log INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


def _mark_session_failed(session_id, error_msg, phase=3):
    if not session_id:
        return
    conn = _get_db_conn()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE diagnosis_session
            SET status='failed', error_message=%s, completed_at=NOW(), current_phase=%s
            WHERE session_id=%s
            """,
            (str(error_msg)[:1000], phase, session_id),
        )
        conn.commit()
    except Exception as e:
        logger.warning("diagnosis_session UPDATE 실패: %s", e)
    finally:
        conn.close()


# ── DB read helpers (session_id 로 phase1/2/lab input 모음) ─────
def _read_inputs_from_db(session_id: str | None) -> dict:
    """phase1_hpo_extraction + phase2_xray_processing + lab_result 에서
    score_all body 형식으로 input dict 생성.

    Returns:
      {
        "patient_lab_findings": [LabFinding 호환 dict, ...],
        "patient_symptom_matches": [SymptomMatch 호환 dict, ...],
        "phase1_result": {detected_findings, possible_findings, all_predictions, ...},
        "patient_micro_findings": [],
        "scoring_results": [],
      }
    """
    if not session_id:
        return {}
    conn = _get_db_conn()
    if not conn:
        return {}
    out = {
        "patient_lab_findings": [],
        "patient_symptom_matches": [],
        "phase1_result": None,
        "patient_micro_findings": [],
        "scoring_results": [],
    }
    try:
        cur = conn.cursor()

        # 1) phase1_hpo_extraction + phase2 xray_hpo_inferred → SymptomMatch[]
        #    raw HPO list 를 SymptomMatcher.match() 로 enrich:
        #    matched_diseases 가 disease_registry 매칭으로 채워져 score_all 가 의미 있게.
        patient_hpo_ids = []
        hpo_id_term: dict[str, str] = {}

        # phase1 positive HPO — list[str] (new schema) 또는 list[dict] (legacy) 모두 처리
        cur.execute(
            """SELECT positive_hpo FROM phase1_hpo_extraction
               WHERE session_id=%s ORDER BY executed_at DESC LIMIT 1""",
            (session_id,),
        )
        row = cur.fetchone()
        if row and row[0]:
            for h in row[0]:
                hid = h if isinstance(h, str) else (
                    h.get("hpo_id") if isinstance(h, dict) else None)
                if hid:
                    patient_hpo_ids.append(hid)
                    if isinstance(h, dict):
                        hpo_id_term[hid] = (h.get("official_term") or
                                            h.get("llm_extracted_term") or "")

        # phase2 xray_hpo_inferred (positive HPO 추출)
        cur.execute(
            """SELECT xray_hpo_inferred FROM phase2_xray_processing
               WHERE session_id=%s ORDER BY executed_at DESC LIMIT 1""",
            (session_id,),
        )
        row = cur.fetchone()
        if row and row[0] and isinstance(row[0], dict):
            for hid in (row[0].get("positive_hpos") or []):
                if hid and hid not in patient_hpo_ids:
                    patient_hpo_ids.append(hid)

        # SymptomMatcher.match() — DiseaseRegistry 의 모든 질환과 매칭. matched_diseases 채워짐
        if _MATCHER is not None and _REGISTRY is not None and patient_hpo_ids:
            try:
                matches = _MATCHER.match(
                    patient_symptoms=[],
                    patient_hpo_ids=patient_hpo_ids,
                    disease_profiles=_REGISTRY.get_all(),
                )
                # SymptomMatch dataclass → dict (score_all 의 body 형식)
                from dataclasses import asdict as _asdict
                for sm in matches:
                    d = _asdict(sm)
                    # 안전한 직렬화 (datetime/enum 등)
                    out["patient_symptom_matches"].append(json.loads(json.dumps(d, default=str)))
                logger.info("SymptomMatcher: %d HPO → %d matches (with matched_diseases)",
                            len(patient_hpo_ids), len(matches))
            except Exception as e:
                logger.warning("SymptomMatcher failed: %s — fallback to bare HPO list", e)
                for hid in patient_hpo_ids:
                    out["patient_symptom_matches"].append({
                        "symptom": hpo_id_term.get(hid, ""), "hpo_id": hid,
                        "hpo_kr": "", "frequency": "", "matched_diseases": [],
                    })
        else:
            for hid in patient_hpo_ids:
                out["patient_symptom_matches"].append({
                    "symptom": hpo_id_term.get(hid, ""), "hpo_id": hid,
                    "hpo_kr": "", "frequency": "", "matched_diseases": [],
                })

        # 2) phase2_xray_processing (densenet_findings) → Phase1Result.all_predictions
        cur.execute(
            """SELECT densenet_findings FROM phase2_xray_processing
               WHERE session_id=%s ORDER BY executed_at DESC LIMIT 1""",
            (session_id,),
        )
        row = cur.fetchone()
        if row and row[0]:
            preds = row[0]   # {"Atelectasis": {"probability": 0.35, "hpo_code": "HP:0002095"}, ...}
            all_preds = []
            for label, info in (preds.items() if isinstance(preds, dict) else []):
                if isinstance(info, dict):
                    all_preds.append({"label": label, "probability": float(info.get("probability", 0.0))})
            out["phase1_result"] = {
                "detected_findings": [],
                "possible_findings": [],
                "all_predictions": all_preds,
                "candidate_icd_codes": [],
                "ai_keywords_matched": [],
                "gradcam_paths": {},
            }

        # 3) lab_result (patient_id 경유) → LabFinding dict[]
        cur.execute(
            """SELECT patient_id FROM diagnosis_session WHERE session_id=%s""",
            (session_id,),
        )
        prow = cur.fetchone()
        if prow:
            patient_id = prow[0]
            cur.execute(
                """SELECT test_name_en, value_numeric, value_text, value_unit,
                          reference_low, reference_high, abnormal_flag, severity, loinc_code,
                          observation_category
                   FROM lab_result WHERE patient_id=%s
                   ORDER BY measured_at DESC LIMIT 200""",
                (patient_id,),
            )
            for r in cur.fetchall():
                out["patient_lab_findings"].append({
                    "itemid": r[8] or "",
                    "name": r[0] or "",
                    "value": float(r[1]) if r[1] is not None else 0.0,
                    "unit": r[3] or "",
                    "ref_lower": float(r[4]) if r[4] is not None else None,
                    "ref_upper": float(r[5]) if r[5] is not None else None,
                    "interpretation": r[6] or "",
                    "medical_term": r[0] or "",
                    "severity": r[7] or "normal",
                    "disease_associations": [],
                    "ref_source": "",
                    "name_kr": "",
                    "thresholds_triggered": [],
                    "scoring_contributions": {},
                    "hpo_id": "",
                    "category": r[9] or "lab",
                })
        return out
    except Exception as e:
        logger.warning("DB read 실패: %s", e)
        return out
    finally:
        conn.close()


def _insert_phase3_ranking(session_id, ranking_dicts, scoring_dict, scoring_process_dict,
                           unified_pos_hpo, unified_neg_hpo, modality_weights,
                           stage1_count, stage2_count, inference_time_ms):
    """phase3_integrated_ranking INSERT (production schema v1.1 + scoring/scoring_process 컬럼)."""
    if not session_id:
        return None
    conn = _get_db_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO phase3_integrated_ranking (
                session_id, phase, executed_at,
                lab_anomalies, lab_ref_ver,
                unified_positive_hpo, unified_negative_hpo, modality_weights,
                yaml_ssot_ver, rare_db_ver,
                stage1_filtered_count, stage2_full_lr_count,
                ranking, inference_time_ms,
                scoring, scoring_process
            ) VALUES (
                %s, 3, NOW(),
                %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s
            )
            """,
            (
                session_id,
                PgJson([]), "v9.5",                                    # lab_anomalies, lab_ref_ver
                PgJson(unified_pos_hpo), PgJson(unified_neg_hpo),
                PgJson(modality_weights),
                "v3.2", "v7",                                          # yaml_ssot_ver, rare_db_ver
                stage1_count, stage2_count,
                PgJson(ranking_dicts), inference_time_ms,
                PgJson(scoring_dict), PgJson(scoring_process_dict),
            ),
        )
        conn.commit()
        return True
    except Exception as e:
        logger.warning("phase3_integrated_ranking INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


# ── Globals (warm container 재사용) ─────────────────────────────
_REGISTRY: DiseaseRegistry | None = None
_SCORER: DiagnosticScorer | None = None
_MATCHER: SymptomMatcher | None = None
_REGISTRY_LOADED_AT: str | None = None


def _ensure_initialized() -> None:
    """Cold start 1회만 실행. Warm 호출은 globals 재사용."""
    global _REGISTRY, _SCORER, _MATCHER, _REGISTRY_LOADED_AT
    if _SCORER is not None:
        return

    data_dir = os.environ.get("DATA_DIR", "/opt/data")
    # lung_dx.config.paths가 data 디렉토리를 환경변수로 override 가능하다는 전제.
    # 만약 paths.py가 절대경로 hard-coded면 PROJECT_DATA_DIR 환경변수 추가 필요.
    os.environ.setdefault("LUNG_DX_DATA_DIR", data_dir)

    t0 = time.perf_counter()
    _REGISTRY = DiseaseRegistry()
    _REGISTRY.load()
    _SCORER = DiagnosticScorer(_REGISTRY)
    _MATCHER = SymptomMatcher()
    _REGISTRY_LOADED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    logger.info("DiseaseRegistry + SymptomMatcher loaded in %.2fs",
                time.perf_counter() - t0)


# ── 입력 dataclass 변환 helpers ──────────────────────────────────
def _to_lab_finding(d: dict) -> LabFinding:
    return LabFinding(
        itemid=d.get("itemid", ""),
        name=d.get("name", ""),
        value=d.get("value", 0.0),
        unit=d.get("unit", ""),
        ref_lower=d.get("ref_lower"),
        ref_upper=d.get("ref_upper"),
        interpretation=d.get("interpretation", ""),
        medical_term=d.get("medical_term", ""),
        severity=d.get("severity", "normal"),
        disease_associations=d.get("disease_associations", []),
        ref_source=d.get("ref_source", ""),
        name_kr=d.get("name_kr", ""),
        thresholds_triggered=d.get("thresholds_triggered", []),
        scoring_contributions=d.get("scoring_contributions", {}),
        hpo_id=d.get("hpo_id", ""),
        category=d.get("category", ""),
    )


def _to_micro(d: dict) -> MicroFinding:
    return MicroFinding(
        organism=d.get("organism", ""),
        matched_diseases=d.get("matched_diseases", []),
    )


def _to_symptom(d: dict) -> SymptomMatch:
    return SymptomMatch(
        symptom=d.get("symptom", ""),
        hpo_id=d.get("hpo_id", ""),
        hpo_kr=d.get("hpo_kr", ""),
        frequency=d.get("frequency", ""),
        matched_diseases=d.get("matched_diseases", []),
    )


def _to_radiology(d: dict) -> RadiologyFinding:
    return RadiologyFinding(
        finding=d.get("finding", ""),
        present=d.get("present", True),
        probability=d.get("probability", 0.0),
        ai_keywords=d.get("ai_keywords", []),
        location=d.get("location"),
        icd10_codes=d.get("icd10_codes", []),
    )


def _to_phase1(d: dict | None) -> Phase2Result | None:
    """phase2_xray_processing DB row → Phase2Result dataclass.
    함수명 _to_phase1 은 historical (이전 Phase1Result 였음); 새 lung_dx 에서는
    Phase 2 의 X-ray 결과를 Phase2Result 로 명명."""
    if not d:
        return None
    return Phase2Result(
        detected_findings=[_to_radiology(x) for x in d.get("detected_findings", [])],
        possible_findings=[_to_radiology(x) for x in d.get("possible_findings", [])],
        all_predictions=[
            XrayPrediction(label=x.get("label", ""), probability=x.get("probability", 0.0))
            for x in d.get("all_predictions", [])
        ],
        candidate_icd_codes=d.get("candidate_icd_codes", []),
        ai_keywords_matched=d.get("ai_keywords_matched", []),
        gradcam_paths=d.get("gradcam_paths", {}),
    )


def _to_scoring_system(d: dict) -> ScoringSystemResult:
    return ScoringSystemResult(
        name=d.get("name", ""),
        score=d.get("score", 0),
        interpretation=d.get("interpretation", ""),
        components=d.get("components", {}),
    )


# ── 출력 직렬화 ─────────────────────────────────────────────────
def _serialize_results(results: list, elapsed_ms: float, request_id: str) -> dict:
    return {
        "results": [asdict(r) for r in results],
        "metadata": {
            "registry_version": "v3.2",
            "registry_loaded_at": _REGISTRY_LOADED_AT,
            "request_id": request_id,
            "elapsed_ms": round(elapsed_ms, 2),
        },
    }


# ── 응답 helpers ────────────────────────────────────────────────
def _ok(payload: Any) -> dict:
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(payload, default=str, ensure_ascii=False),
    }


def _bad(msg: str, status: int = 400) -> dict:
    logger.warning("phase3 client error: %s", msg)
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps({"error": msg}, ensure_ascii=False),
    }


def _server_error(exc: Exception) -> dict:
    logger.exception("phase3 unhandled error: %s", exc)
    return {
        "statusCode": 500,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(
            {"error": "internal_server_error", "type": type(exc).__name__},
            ensure_ascii=False,
        ),
    }


# ── Lambda 진입점 ────────────────────────────────────────────────
def lambda_handler(event: dict, context) -> dict:
    request_id = getattr(context, "aws_request_id", "local")
    function_name = getattr(context, "function_name", "phase3")
    t_started = time.time()

    # /health 체크 — registry 미로드여도 Lambda alive 검증
    path = event.get("path") or event.get("rawPath") or ""
    if path.endswith("/health"):
        return _ok({"status": "ok", "registry_loaded": _SCORER is not None})

    # session_id / patient_id 추출 (event 최상위 또는 body 내부 — 호출자 결정)
    session_id = event.get("session_id")
    patient_id = event.get("patient_id")

    try:
        _ensure_initialized()
    except Exception as e:
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase3", phase_step="ensure_initialized", status="failed",
            started_at=t_started, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"init: {e}", phase=3)
        return _server_error(e)

    # API GW proxy → body는 string, 직접 invoke → dict
    body = event.get("body") if isinstance(event.get("body"), (str, dict)) else event
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            return _bad("body is not valid JSON")
    if not isinstance(body, dict):
        return _bad("expected JSON object")

    session_id = session_id or body.get("session_id")
    patient_id = patient_id or body.get("patient_id")

    # ── Step Functions invoke 호환: body 가 session_id 만 있으면 DB 에서 input read.
    #    backward compat: 기존 body 에 인자가 있으면 그대로 사용 (API GW 호출 케이스).
    if session_id and not any(body.get(k) for k in
            ("patient_lab_findings","patient_symptom_matches","phase1_result")):
        db_input = _read_inputs_from_db(session_id)
        # body 에 없는 키만 채움
        for k, v in db_input.items():
            body.setdefault(k, v)

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase3", phase_step="score_all", status="started",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        input_summary={
            "lab_count": len(body.get("patient_lab_findings", []) or []),
            "micro_count": len(body.get("patient_micro_findings", []) or []),
            "symptom_count": len(body.get("patient_symptom_matches", []) or []),
            "has_phase1": bool(body.get("phase1_result")),
            "scoring_count": len(body.get("scoring_results", []) or []),
            "top_n": int(body.get("top_n", 10)),
        },
    )

    try:
        lab_findings = [_to_lab_finding(x) for x in body.get("patient_lab_findings", [])]
        micro = [_to_micro(x) for x in body.get("patient_micro_findings", [])]
        symptoms = [_to_symptom(x) for x in body.get("patient_symptom_matches", [])]
        phase1 = _to_phase1(body.get("phase1_result"))
        scoring = [_to_scoring_system(x) for x in body.get("scoring_results", [])]
        top_n = int(body.get("top_n", 10))
        include_rare = bool(body.get("include_rare", False))
    except (TypeError, ValueError) as e:
        return _bad(f"input dataclass construction failed: {e}")

    t0 = time.perf_counter()
    try:
        results = _SCORER.score_all(
            patient_lab_findings=lab_findings,
            patient_micro_findings=micro if micro else None,
            patient_symptom_matches=symptoms if symptoms else None,
            phase2_result=phase1,
            scoring_results=scoring if scoring else None,
            top_n=top_n,
            include_rare=include_rare,
        )
    except Exception as e:
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase3", phase_step="score_all", status="failed",
            started_at=t_started, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"score_all: {e}", phase=3)
        return _server_error(e)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    # ── phase3_integrated_ranking INSERT (production schema 매핑) ──
    # asdict() 결과 안에 Enum (Confidence 등) / datetime 가 섞여 있어서
    # json.dumps(default=str) 로 한 번 강제 직렬화 후 다시 dict 로.
    ranking_dicts = json.loads(json.dumps([asdict(r) for r in results], default=str))
    unified_pos = [m.get("hpo_id") for m in body.get("patient_symptom_matches", []) if isinstance(m, dict) and m.get("hpo_id")]
    _insert_phase3_ranking(
        session_id=session_id,
        ranking_dicts=ranking_dicts,
        scoring_dict={},                            # 추후 채움
        scoring_process_dict={
            "elapsed_ms": round(elapsed_ms, 2),
            "registry_version": "v3.2",
            "include_rare": include_rare,
            "top_n": top_n,
        },
        unified_pos_hpo=unified_pos,
        unified_neg_hpo=[],
        modality_weights={"lab": 1.0, "symptom": 1.0, "radiology": 1.0, "micro": 1.0},
        stage1_count=len(ranking_dicts),
        stage2_count=len(ranking_dicts),
        inference_time_ms=int(elapsed_ms),
    )

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase3", phase_step="score_all", status="succeeded",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        output_summary={
            "results_count": len(results),
            "elapsed_ms": round(elapsed_ms, 2),
        },
    )

    return _ok(_serialize_results(results, elapsed_ms, request_id))
