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
    try:
        rag = _get_rag_system()
        result = rag.run_with_session_id(session_id)
        elapsed_ms = (time.monotonic() - t_start) * 1000

        logger.info(
            "Completed session_id=%s elapsed_ms=%.0f",
            session_id,
            elapsed_ms,
        )

        # 최종 보고서는 DB에 저장됨 — 응답은 session_id + status만 반환 (Lambda 6MB 응답 한도)
        response_body = {"session_id": session_id, "status": "completed"}

        return _ok(response_body, request_id=request_id, elapsed_ms=elapsed_ms)

    except ValueError as exc:
        logger.warning("Validation error for session_id=%s: %s", session_id, exc)
        return _bad(str(exc), request_id=request_id)

    except Exception as exc:
        elapsed_ms = (time.monotonic() - t_start) * 1000
        logger.exception(
            "Unhandled error for session_id=%s elapsed_ms=%.0f: %s",
            session_id,
            elapsed_ms,
            exc,
        )
        return _server_error(
            f"Internal error: {type(exc).__name__}",
            request_id=request_id,
        )
