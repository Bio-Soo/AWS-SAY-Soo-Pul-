"""Phase 4 — LLM Verification Lambda handler.

API Gateway proxy integration. Reads JSON body, builds Phase4Input,
calls Phase4Verifier.verify(), serializes Phase4Result back to JSON.

Layer:
  - phase4-deps: /opt/python/lung_dx + boto3 patch (런타임 boto3는 Lambda 기본 제공)

Environment:
  BEDROCK_MODEL_ID  (default anthropic.claude-sonnet-4-6)
  BEDROCK_REGION    (default us-east-1)
  PYTHONPATH        (default /opt/python)
  LOG_LEVEL         (default INFO)
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

sys.path.insert(0, os.environ.get("PYTHONPATH", "/opt/python"))

# lung_dx 가 yaml 을 찾을 base directory. deps Layer 의 /opt/python/data/ 에 yaml 들 있음.
os.environ.setdefault("LUNG_DX_DATA_DIR", "/opt/python/data")

from lung_dx.phase4_llm_verify.schemas import Phase4Input  # noqa: E402
from lung_dx.phase4_llm_verify.verifier import Phase4Verifier  # noqa: E402
# Layer 의 BedrockPhase4Verifier 가 region='us-east-1' default 사용 → VPC outbound 없음.
# Lambda 의 ap-northeast-2 VPC Endpoint 를 거치려면 region 을 env vars 로 강제.
from lung_dx.phase4_llm_verify import bedrock_verifier as _bv  # noqa: E402

_orig_bv_init = _bv.BedrockPhase4Verifier.__init__
def _patched_bv_init(self, *args, **kwargs):
    kwargs.setdefault('region', os.environ.get('BEDROCK_REGION', 'ap-northeast-2'))
    _orig_bv_init(self, *args, **kwargs)
_bv.BedrockPhase4Verifier.__init__ = _patched_bv_init

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
    phase_name="phase4",
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


def _mark_session_failed(session_id, error_msg, phase=4):
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


# ── DB read helpers (session_id → phase3 ranking) ───────────────
def _read_inputs_from_db(session_id: str | None) -> dict:
    """phase3_integrated_ranking + phase1_hpo_extraction + diagnosis_session 에서
    phase4 verifier body 형식 생성.

    Returns: {phase3_ranking, matched_hp_ids, hp_id_to_term, patient_age, patient_sex, ...}
    """
    if not session_id:
        return {}
    conn = _get_db_conn()
    if not conn:
        return {}
    out = {
        "phase3_ranking": [],
        "matched_hp_ids": [],
        "hp_id_to_term": {},
        "patient_history": [],
        "patient_medications": [],
        "xray_findings": [],
        "lab_summary": [],
        "clinical_scores": {},
    }
    try:
        cur = conn.cursor()

        # phase3 ranking
        cur.execute(
            """SELECT ranking, executed_at FROM phase3_integrated_ranking
               WHERE session_id=%s ORDER BY executed_at DESC LIMIT 1""",
            (session_id,),
        )
        row = cur.fetchone()
        if row and row[0]:
            out["phase3_ranking"] = row[0]
            out["_p3_executed_at"] = row[1]

        # phase1 positive HPO → matched_hp_ids + hp_id_to_term
        cur.execute(
            """SELECT positive_hpo FROM phase1_hpo_extraction
               WHERE session_id=%s ORDER BY executed_at DESC LIMIT 1""",
            (session_id,),
        )
        row = cur.fetchone()
        if row and row[0]:
            for h in row[0]:
                if isinstance(h, dict):
                    hid = h.get("hpo_id")
                    if hid:
                        out["matched_hp_ids"].append(hid)
                        out["hp_id_to_term"][hid] = h.get("official_term") or h.get("llm_extracted_term") or hid

        # phase2 xray_hpo_inferred → xray_findings (label list)
        cur.execute(
            """SELECT xray_hpo_inferred FROM phase2_xray_processing
               WHERE session_id=%s ORDER BY executed_at DESC LIMIT 1""",
            (session_id,),
        )
        row = cur.fetchone()
        if row and row[0]:
            xh = row[0]
            if isinstance(xh, dict):
                out["xray_findings"] = list(xh.get("positive_hpos", []))

        # patient demographics
        cur.execute(
            """SELECT pp.age_years, pp.sex
               FROM diagnosis_session ds
               LEFT JOIN patient_profile pp ON pp.patient_id = ds.patient_id
               WHERE ds.session_id=%s""",
            (session_id,),
        )
        row = cur.fetchone()
        if row:
            out["patient_age"] = row[0]
            out["patient_sex"] = row[1] or "unknown"
        return out
    except Exception as e:
        logger.warning("DB read 실패: %s", e)
        return out
    finally:
        conn.close()


def _insert_phase4_rerank(session_id, result_dict, llm_model, elapsed_ms, p3_executed_at):
    """phase4_llm_rerank INSERT (production v1.1 + token/cost 컬럼)."""
    if not session_id:
        return None
    conn = _get_db_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        # 안전한 직렬화 (Enum/datetime → str)
        serialized = json.loads(json.dumps(result_dict, default=str))
        cur.execute(
            """
            INSERT INTO phase4_llm_rerank (
                session_id, phase, executed_at,
                agrees_with_top1, reranked, flagged_concerns,
                reasoning_summary, s3_reasoning_full,
                llm_model, prompt_ver, inference_time_ms,
                rank_changes, input_tokens, output_tokens, inference_cost_usd,
                p3_executed_at
            ) VALUES (
                %s, 4, NOW(),
                %s, %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s
            )
            """,
            (
                session_id,
                serialized.get("agrees_with_top1"),
                PgJson(serialized.get("reranked") or []),
                PgJson(serialized.get("flagged_concerns") or []),
                serialized.get("reasoning_summary"), None,                       # s3_reasoning_full
                llm_model, serialized.get("prompt_ver") or "v1", int(elapsed_ms),
                PgJson(serialized.get("rank_changes") or []),
                serialized.get("input_tokens"), serialized.get("output_tokens"),
                serialized.get("inference_cost_usd"),
                p3_executed_at,
            ),
        )
        conn.commit()
        return True
    except Exception as e:
        logger.warning("phase4_llm_rerank INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


# ── Globals (warm container 재사용) ─────────────────────────────
_VERIFIERS: dict[str, Phase4Verifier] = {}


def _get_verifier(mode: str) -> Phase4Verifier:
    """mode별 verifier 캐싱. cold start에 1회씩 생성."""
    key = mode
    if key not in _VERIFIERS:
        model_id = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-6")
        _VERIFIERS[key] = Phase4Verifier(mode=mode, model_id=model_id)
        logger.info("Phase4Verifier initialized: mode=%s model=%s", mode, model_id)
    return _VERIFIERS[key]


# ── 입력 변환 ───────────────────────────────────────────────────
def _to_phase4_input(body: dict) -> Phase4Input:
    return Phase4Input(
        phase3_ranking=body.get("phase3_ranking", []),
        matched_hp_ids=body.get("matched_hp_ids", []),
        patient_age=body.get("patient_age"),
        patient_sex=body.get("patient_sex", "unknown"),
        patient_history=body.get("patient_history", []),
        patient_medications=body.get("patient_medications", []),
        xray_findings=body.get("xray_findings", []),
        lab_summary=body.get("lab_summary", []),
        clinical_scores=body.get("clinical_scores", {}),
    )


# ── 응답 helpers ────────────────────────────────────────────────
def _ok(payload: Any) -> dict:
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(payload, default=str, ensure_ascii=False),
    }


def _bad(msg: str, status: int = 400) -> dict:
    logger.warning("phase4 client error: %s", msg)
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps({"error": msg}, ensure_ascii=False),
    }


def _server_error(exc: Exception) -> dict:
    logger.exception("phase4 unhandled error: %s", exc)
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
    function_name = getattr(context, "function_name", "phase4")
    t_started = time.time()

    path = event.get("path") or event.get("rawPath") or ""
    if path.endswith("/health"):
        return _ok({"status": "ok", "warm_modes": list(_VERIFIERS.keys())})

    session_id = event.get("session_id")
    patient_id = event.get("patient_id")

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

    # Step Functions invoke 호환: body 에 phase3_ranking 없으면 DB 에서 read.
    p3_executed_at = None
    if session_id and not body.get("phase3_ranking"):
        db_input = _read_inputs_from_db(session_id)
        p3_executed_at = db_input.pop("_p3_executed_at", None)
        for k, v in db_input.items():
            body.setdefault(k, v)

    # mode: 'real' (Bedrock 호출) 또는 'mock' (fixture 응답, AWS 미사용)
    mode = body.get("mode", "real")
    if mode not in ("real", "mock"):
        return _bad("mode must be 'real' or 'mock'")

    if not body.get("phase3_ranking"):
        return _bad("phase3_ranking is required (Phase 3 output or DB read)")

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase4", phase_step="verify", status="started",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        input_summary={
            "mode": mode,
            "phase3_ranking_count": len(body.get("phase3_ranking", []) or []),
            "matched_hp_ids_count": len(body.get("matched_hp_ids", []) or []),
            "has_hp_id_to_term": bool(body.get("hp_id_to_term")),
        },
        model_versions={"model_id": os.environ.get("BEDROCK_MODEL_ID")},
    )

    try:
        verifier = _get_verifier(mode)
        input_data = _to_phase4_input(body)
        hp_id_to_term = body.get("hp_id_to_term")  # optional dict
    except Exception as e:
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase4", phase_step="verifier_init", status="failed",
            started_at=t_started, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"verifier init: {e}", phase=4)
        return _server_error(e)

    t0 = time.perf_counter()
    try:
        result = verifier.verify(input_data, hp_id_to_term=hp_id_to_term)
    except Exception as e:
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase4", phase_step="verify", status="failed",
            started_at=t_started, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"verify: {e}", phase=4)
        return _server_error(e)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase4", phase_step="verify", status="succeeded",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        output_summary={"elapsed_ms": round(elapsed_ms, 2)},
        model_versions={"model_id": os.environ.get("BEDROCK_MODEL_ID")},
    )

    payload = asdict(result)

    # ── phase4_llm_rerank INSERT (production schema) ──
    _insert_phase4_rerank(
        session_id=session_id,
        result_dict=payload,
        llm_model=os.environ.get("BEDROCK_MODEL_ID"),
        elapsed_ms=elapsed_ms,
        p3_executed_at=p3_executed_at,
    )

    payload["metadata"] = {
        "model_id": os.environ.get("BEDROCK_MODEL_ID"),
        "request_id": request_id,
        "elapsed_ms": round(elapsed_ms, 2),
    }
    return _ok(payload)
