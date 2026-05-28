"""Phase 5 LR Lambda 핸들러 — LIRICAL Likelihood Ratio scoring.

기존 phase5-rag-dev (RAG 보고서) 와 분리된 신규 Lambda. 역할:
  1. session_id 로 DB 에서 phase1+phase2+lab raw 읽기 (DBReader)
  2. Step 0 HPO 정규화 (lab → HPO best-effort)
  3. LIRICAL LR 계산 (LIRICALEngine, KB: rare_disease_profiles_v3_1.yaml)
  4. phase5_rare_disease_listing INSERT (v4 DDL by 권미라)
  5. phase_execution_log INSERT (Phase 3, 4, 5 통합 로깅 패턴)

입력 (API Gateway / Step Functions / 직접 invoke):
    {"session_id": "uuid", "patient_id": "..." (옵션)}

출력:
    {"statusCode": 200, "body": "{\"session_id\":..., \"listed_count\":N, ...}"}
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
import uuid

import boto3

try:
    import psycopg2
    from psycopg2.extras import Json as PgJson
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False

# Lambda Layer 경로
sys.path.insert(0, "/var/task")    # lambda/ 패키지 (handler/lr_engine/db_reader)
sys.path.insert(1, "/opt/python")  # deps Layer (psycopg2, yaml)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter("[%(levelname)s] %(asctime)s %(name)s - %(message)s"))
    logger.addHandler(h)


# ────────────────────────────────────────────────────────────────
# DB 연결 헬퍼 (기존 phase5/handler.py 와 동일 패턴)
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
    return "infra"


def _record_phase_log(
    session_id=None, patient_id=None,
    phase_name="phase5", phase_step="", status="started",
    started_at=None, error=None,
    lambda_request_id="", lambda_function="",
    input_summary=None, output_summary=None, model_versions=None,
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


def _mark_session_failed(session_id, error_msg, phase=5):
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


# ────────────────────────────────────────────────────────────────
# LR 엔진 + DB Reader (cold start 시 1회 로드)
# ────────────────────────────────────────────────────────────────
_LR_ENGINE = None
_DB_READER = None
_KB_VERSION = None


def _initialize():
    global _LR_ENGINE, _DB_READER, _KB_VERSION
    if _LR_ENGINE is not None:
        return
    from lr_engine import LIRICALEngine, load_rare_disease_kb, load_background_freq
    from db_reader import DBReader

    data_dir = os.environ.get("DATA_DIR", "/opt/data")
    bg_path = os.path.join(data_dir, "hpo_background_freq.json")
    kb_path = os.path.join(data_dir, "rare_disease_profiles_v3_1.yaml")

    t0 = time.monotonic()
    background_freq = load_background_freq(bg_path)
    rare_diseases_kb, kb_ver = load_rare_disease_kb(kb_path)
    _LR_ENGINE = LIRICALEngine(
        background_freq=background_freq,
        rare_diseases_kb=rare_diseases_kb,
    )
    _DB_READER = DBReader(get_conn_fn=_get_db_conn)
    _KB_VERSION = kb_ver
    logger.info(
        "Initialized: %d HPO bg-freq / %d rare diseases / KB=%s / %.2fs",
        len(background_freq), len(rare_diseases_kb), kb_ver, time.monotonic() - t0,
    )


# ────────────────────────────────────────────────────────────────
# 응답 헬퍼
# ────────────────────────────────────────────────────────────────
def _ok(body, request_id="", elapsed_ms=0.0):
    payload = {**body, "request_id": request_id, "elapsed_ms": round(elapsed_ms)}
    return {"statusCode": 200, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(payload, ensure_ascii=False, default=str)}


def _bad(message, request_id=""):
    return {"statusCode": 400, "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": message, "request_id": request_id}, ensure_ascii=False)}


def _server_error(message, request_id=""):
    return {"statusCode": 500, "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": message, "request_id": request_id}, ensure_ascii=False)}


# ────────────────────────────────────────────────────────────────
# phase5_rare_disease_listing INSERT (v4 DDL by 권미라)
# ────────────────────────────────────────────────────────────────
def _insert_phase5_listing(
    session_id, input_hpo_used, listed_diseases, audit_trail, step0_log,
    inference_time_ms, kb_version,
):
    conn = _get_db_conn()
    if not conn:
        raise RuntimeError("DB connection failed for phase5_rare_disease_listing INSERT")
    try:
        cur = conn.cursor()
        top = listed_diseases[0] if listed_diseases else None
        top_lr_score = top["lr_value"] if top else None
        top_lr_orphacode = top["orphacode"] if top else None

        cur.execute(
            """
            INSERT INTO phase5_rare_disease_listing (
                session_id, executed_at,
                input_phase4_top_orphas, input_hpo_used,
                rare_db_ver, rare_db_source,
                listed_diseases, listing_criteria,
                total_listed_count, top_lr_score, top_lr_orphacode,
                external_api_called, external_api_versions,
                inference_time_ms, audit_trail, step0_log, input_data_meta
            ) VALUES (
                %s, NOW(),
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s, %s, %s
            )
            """,
            (
                session_id,
                [], PgJson(input_hpo_used),                                # input_phase4_top_orphas DEPRECATED → []
                kb_version, "local_orphadata",
                PgJson(listed_diseases),
                PgJson({"threshold_lr": 5.0, "sort": "lr_desc", "engine": "LIRICAL"}),
                len(listed_diseases), top_lr_score, top_lr_orphacode,
                False, None,
                inference_time_ms, PgJson(audit_trail), PgJson(step0_log),
                PgJson({"engine": "LIRICAL", "ref": "Robinson 2020 (PMID:32755546)"}),
            ),
        )
        conn.commit()
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────
# Lambda 진입점
# ────────────────────────────────────────────────────────────────
def lambda_handler(event, context):
    request_id = getattr(context, "aws_request_id", "local")
    function_name = getattr(context, "function_name", "phase5-lr")
    t_start = time.monotonic()
    t_started_epoch = time.time()

    # /health
    http_method = event.get("httpMethod", "")
    path = event.get("path", "") or event.get("rawPath", "")
    if http_method == "GET" and (path.endswith("/health") or path == "/health"):
        return _ok({"status": "healthy", "engine_loaded": _LR_ENGINE is not None},
                   request_id=request_id)

    # session_id 추출 (top-level / body str / body dict)
    session_id = event.get("session_id")
    patient_id = event.get("patient_id")
    if session_id is None:
        raw_body = event.get("body", "")
        if isinstance(raw_body, str) and raw_body:
            try:
                body_dict = json.loads(raw_body)
                session_id = body_dict.get("session_id")
                patient_id = patient_id or body_dict.get("patient_id")
            except json.JSONDecodeError:
                pass
        elif isinstance(raw_body, dict):
            session_id = raw_body.get("session_id")
            patient_id = patient_id or raw_body.get("patient_id")

    if not session_id:
        return _bad("session_id is required", request_id=request_id)

    # cold start 초기화
    try:
        _initialize()
    except Exception as e:
        logger.exception("초기화 실패")
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase5", phase_step="initialize", status="failed",
            started_at=t_started_epoch, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"initialize: {e}", phase=5)
        return _server_error(f"Init error: {type(e).__name__}", request_id=request_id)

    # 시작 로그
    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase5", phase_step="lr_scoring", status="started",
        started_at=t_started_epoch,
        lambda_function=function_name, lambda_request_id=request_id,
        input_summary={"engine": "LIRICAL"},
        model_versions={"kb": _KB_VERSION},
    )

    try:
        # 1) DB read + Step 0
        patient_hpos, audit_trail, step0_log, input_hpo_used = \
            _DB_READER.read_patient_hpos(session_id)

        # 2) LIRICAL LR
        listed_diseases = _LR_ENGINE.score_all(patient_hpos)
        elapsed_ms = int((time.monotonic() - t_start) * 1000)

        # 3) phase5_rare_disease_listing INSERT
        _insert_phase5_listing(
            session_id=session_id,
            input_hpo_used=input_hpo_used,
            listed_diseases=listed_diseases,
            audit_trail=audit_trail,
            step0_log=step0_log,
            inference_time_ms=elapsed_ms,
            kb_version=_KB_VERSION,
        )

        # 4) 성공 로그
        top_lr = listed_diseases[0]["lr_value"] if listed_diseases else None
        top_orpha = listed_diseases[0]["orphacode"] if listed_diseases else None
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase5", phase_step="lr_scoring", status="succeeded",
            started_at=t_started_epoch,
            lambda_function=function_name, lambda_request_id=request_id,
            output_summary={
                "listed_count": len(listed_diseases),
                "top_lr": top_lr,
                "top_orphacode": top_orpha,
                "patient_hpo_count": step0_log["patient_hpo_count"],
            },
            model_versions={"kb": _KB_VERSION},
        )

        return _ok({
            "session_id": session_id,
            "status": "completed",
            "listed_count": len(listed_diseases),
            "top_lr_score": top_lr,
            "top_lr_orphacode": top_orpha,
        }, request_id=request_id, elapsed_ms=elapsed_ms)

    except ValueError as e:
        logger.warning("Validation error: %s", e)
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase5", phase_step="validation", status="failed",
            started_at=t_started_epoch, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        return _bad(str(e), request_id=request_id)

    except Exception as e:
        logger.exception("LR scoring failed")
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase5", phase_step="lr_scoring", status="failed",
            started_at=t_started_epoch, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"phase5-lr: {e}", phase=5)
        return _server_error(f"Internal error: {type(e).__name__}", request_id=request_id)
