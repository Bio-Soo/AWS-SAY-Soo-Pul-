"""AWS Step Functions wrapper.

문서: §6.3 (Phase 1~5 파이프라인 트리거)
실제 호출은 boto3 stepfunctions client. dev 환경에서는 환경변수
DEV_STEPFN_DUMMY=1 이면 호출 없이 가짜 ARN 반환 → mock 모드.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


def _dummy() -> bool:
    return os.getenv("DEV_STEPFN_DUMMY", "0") in ("1", "true", "yes")


async def start_diagnosis_pipeline(
    *,
    session_id: str,
    patient_fhir_id: str,
    symptom_text: str,
    cxr_s3_key: str | None = None,
    state_machine_arn: str | None = None,
    region: str = "ap-northeast-2",
) -> str:
    """Step Functions StartExecution 호출. execution ARN 반환."""
    payload: dict[str, Any] = {
        "session_id": session_id,
        "patient_fhir_id": patient_fhir_id,
        "symptom_text": symptom_text,
        "cxr_s3_key": cxr_s3_key,
        "started_at": datetime.utcnow().isoformat(),
    }

    if _dummy() or not state_machine_arn:
        fake_arn = f"arn:aws:states:{region}:000000000000:execution:dummy:{uuid.uuid4()}"
        logger.info("STEPFN dummy start session=%s arn=%s", session_id, fake_arn)
        return fake_arn

    # production 경로 — boto3 사용. 실제 권한·VPC 셋업은 백엔드 팀
    try:
        import boto3  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError("boto3 미설치") from e

    client = boto3.client("stepfunctions", region_name=region)
    resp = client.start_execution(
        stateMachineArn=state_machine_arn,
        name=f"sess-{session_id}-{uuid.uuid4().hex[:8]}",
        input=json.dumps(payload, ensure_ascii=False),
    )
    arn = resp["executionArn"]
    logger.info("STEPFN started session=%s arn=%s", session_id, arn)
    return arn
