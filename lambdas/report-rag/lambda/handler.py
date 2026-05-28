"""Phase 5 (RAG) Lambda 핸들러

Phase 4 handler.py 패턴과 동일. rag_llm_3.py는 lambda/ 디렉토리에 함께 패키징됨.

입력 (Step Functions 또는 API Gateway):
    {"session_id": "uuid"}

처리:
    RareLinkHybridDualRAG().run_with_session_id(session_id)
    → DB 읽기 (Phase1~4 결과) → 외부 API RAG → Bedrock → DB 저장

출력:
    {"statusCode": 200, "body": "{\"session_id\": ..., \"status\": \"completed\"}"}
"""

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

# Lambda Layer 및 핸들러 자신의 디렉토리를 경로에 추가
sys.path.insert(0, "/var/task")   # lambda/ 패키지 루트 (rag_llm_3.py 위치)
sys.path.insert(1, "/opt/python")  # Lambda Layer deps

# ----------------------------------------------------------------
# 로깅 설정 — cold start 시 1회만 실행
# ----------------------------------------------------------------
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Lambda root logger가 이미 핸들러를 갖고 있으면 중복 추가 방지
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "[%(levelname)s] %(asctime)s %(name)s — %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    logger.addHandler(handler)

# ----------------------------------------------------------------
# DB 안전망 — RAG 내부 _mark_session_failed가 동작하지 않는 경우
# (cold-start/import 실패) 를 위한 모듈 레벨 헬퍼.
# ----------------------------------------------------------------
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
    input_summary=None, output_summary=None,
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
                error_code, error_message, error_stacktrace, error_category
            ) VALUES (
                %s, %s, %s,
                %s, %s, %s,
                COALESCE(to_timestamp(%s), NOW()), NOW(), %s,
                %s, %s,
                %s, %s,
                %s, %s, %s, %s
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
            ),
        )
        conn.commit()
        return log_id
    except Exception as e:
        logger.warning("phase_execution_log INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


def _mark_session_failed_safety_net(session_id, error_msg):
    """RAG _mark_session_failed가 도달하지 못한 경우의 보완용. 멱등."""
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
            SET status='failed', error_message=%s, completed_at=NOW(), current_phase=5
            WHERE session_id=%s
            """,
            (str(error_msg)[:1000], session_id),
        )
        conn.commit()
    except Exception as e:
        logger.warning("diagnosis_session UPDATE 실패: %s", e)
    finally:
        conn.close()


# ----------------------------------------------------------------
# RAG 시스템 — cold start 최적화 (전역 싱글턴)
# ----------------------------------------------------------------
_rag_system = None


def _get_rag_system():
    """RareLinkHybridDualRAG 인스턴스를 싱글턴으로 반환.

    Lambda cold start 시 최초 1회 초기화. 이후 warm 호출에서는
    이미 생성된 인스턴스를 재사용하여 HPO JSON 로딩 비용을 절감.
    """
    global _rag_system
    if _rag_system is None:
        logger.info("Cold start: initializing RareLinkHybridDualRAG...")
        t0 = time.monotonic()
        try:
            from rag_llm_3 import RareLinkHybridDualRAG  # noqa: PLC0415
            _rag_system = RareLinkHybridDualRAG()
            elapsed = time.monotonic() - t0
            logger.info("RareLinkHybridDualRAG initialized in %.2fs", elapsed)
        except Exception as exc:
            logger.exception("Failed to initialize RareLinkHybridDualRAG: %s", exc)
            raise
    return _rag_system


# ----------------------------------------------------------------
# 응답 헬퍼
# ----------------------------------------------------------------

def _ok(body: dict, request_id: str = "", elapsed_ms: float = 0.0) -> dict:
    payload = {
        **body,
        "request_id": request_id,
        "elapsed_ms": round(elapsed_ms),
    }
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(payload, ensure_ascii=False),
    }


def _bad(message: str, request_id: str = "") -> dict:
    return {
        "statusCode": 400,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(
            {"error": message, "request_id": request_id}, ensure_ascii=False
        ),
    }


def _server_error(message: str, request_id: str = "") -> dict:
    return {
        "statusCode": 500,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(
            {"error": message, "request_id": request_id}, ensure_ascii=False
        ),
    }


# ----------------------------------------------------------------
# Lambda 핸들러
# ----------------------------------------------------------------

def lambda_handler(event: dict, context) -> dict:
    """Lambda 진입점.

    Step Functions direct invocation 과 API Gateway 둘 다 처리.

    Args:
        event: Lambda 이벤트. 다음 형식 중 하나:
            - Step Functions: {"session_id": "uuid", ...}
            - API Gateway:    {"httpMethod": "...", "path": "...", "body": "..."}
        context: Lambda 컨텍스트 객체

    Returns:
        API Gateway 호환 응답 dict (statusCode, headers, body)
    """
    request_id: str = getattr(context, "aws_request_id", "local")
    t_start = time.monotonic()

    logger.info(
        "Invocation start — request_id=%s stage=%s",
        request_id,
        os.environ.get("STAGE", "unknown"),
    )

    # ---- /health 경로 처리 ----------------------------------------
    http_method = event.get("httpMethod", "")
    path = event.get("path", "")

    if http_method == "GET" and path == "/health":
        logger.info("Health check OK")
        return _ok(
            {"status": "healthy", "stage": os.environ.get("STAGE", "unknown")},
            request_id=request_id,
            elapsed_ms=(time.monotonic() - t_start) * 1000,
        )

    # ---- session_id 추출 ------------------------------------------
    # 우선순위:
    #   1. Step Functions direct: event["session_id"]
    #   2. API Gateway body (JSON 문자열)
    #   3. API Gateway body (이미 dict — 테스트 콘솔)
    session_id: str | None = event.get("session_id")

    if session_id is None:
        raw_body = event.get("body", "")
        if isinstance(raw_body, str) and raw_body:
            try:
                body_dict = json.loads(raw_body)
                session_id = body_dict.get("session_id")
            except json.JSONDecodeError:
                logger.warning("Failed to parse request body as JSON")
        elif isinstance(raw_body, dict):
            session_id = raw_body.get("session_id")

    if not session_id:
        logger.error("Missing session_id in event: %s", json.dumps(event))
        return _bad(
            "session_id is required (Step Functions payload or JSON body)",
            request_id=request_id,
        )

    logger.info("Processing session_id=%s", session_id)

    # ---- RAG 파이프라인 실행 --------------------------------------
    t_started_epoch = time.time()
    function_name = getattr(context, "function_name", "phase5")

    try:
        rag = _get_rag_system()
        result = rag.run_with_session_id(session_id)
        elapsed_ms = (time.monotonic() - t_start) * 1000

        logger.info(
            "Completed session_id=%s elapsed_ms=%.0f",
            session_id,
            elapsed_ms,
        )

        # 성공 로그 — RAG 내부에서 final_report INSERT 후 본 핸들러까지 도달했음을 기록
        _record_phase_log(
            session_id=session_id,
            phase_name="phase5", phase_step="run_with_session_id", status="succeeded",
            started_at=t_started_epoch,
            lambda_function=function_name, lambda_request_id=request_id,
            output_summary={"elapsed_ms": round(elapsed_ms)},
        )

        # 최종 보고서는 DB에 저장됨 — 응답은 session_id + status만 반환 (Lambda 6MB 응답 한도)
        response_body = {"session_id": session_id, "status": "completed"}

        return _ok(response_body, request_id=request_id, elapsed_ms=elapsed_ms)

    except ValueError as exc:
        logger.warning("Validation error for session_id=%s: %s", session_id, exc)
        # validation 에러는 _mark_session_failed 호출 안 함 (사용자 입력 오류)
        _record_phase_log(
            session_id=session_id,
            phase_name="phase5", phase_step="validation", status="failed",
            started_at=t_started_epoch, error=exc,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        return _bad(str(exc), request_id=request_id)

    except Exception as exc:
        elapsed_ms = (time.monotonic() - t_start) * 1000
        logger.exception(
            "Unhandled error for session_id=%s elapsed_ms=%.0f: %s",
            session_id,
            elapsed_ms,
            exc,
        )
        # 안전망: cold-start/import 실패 시 RAG 내부 _mark_session_failed가 못 돌아감
        # → 모듈 레벨 헬퍼로 보완 (이미 마킹된 경우라도 멱등 UPDATE)
        _record_phase_log(
            session_id=session_id,
            phase_name="phase5", phase_step="run_with_session_id", status="failed",
            started_at=t_started_epoch, error=exc,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed_safety_net(session_id, f"phase5: {exc}")
        return _server_error(
            f"Internal error: {type(exc).__name__}",
            request_id=request_id,
        )
