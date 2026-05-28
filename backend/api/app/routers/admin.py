"""관리자/시스템 라우터 — 워크리스트 + daily preload 트리거.

문서: §6.4 — 매일 아침 EventBridge cron 으로 자동 실행되는 환자 사전 로딩.
production 에서는 Step Functions DailyPatientPreload 를 EventBridge 가 트리거,
이 endpoint 는 manual rerun 용 (운영자 admin).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...shared.db_models import PatientCache
from ...shared.schemas import PatientWorklistItem, WorklistResponse
from ..config import Settings
from ..deps import Clinician, get_current_clinician, get_db
from ..services import s3_emr
from ..services.audit_log import log_session_access
from ..services.hapi_client import HapiClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["admin"])


def _settings() -> Settings:
    return Settings.from_env()


@router.get("/worklist", response_model=WorklistResponse)
async def get_worklist(
    date: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    clinician: Clinician = Depends(get_current_clinician),
) -> WorklistResponse:
    """오늘 워크리스트.

    s3-mock: s3://<bucket>/mock-emr/worklist.json 에서 직접 fetch.
    hapi:    DB patient_cache 에서 (preload 결과).
    """
    s = _settings()
    if s.emr_data_source == "s3-mock":
        wl = s3_emr.get_worklist()
        # date 파라미터 무시하고 mock 의 그대로 반환 (mock 은 단일 날짜)
        return WorklistResponse(**wl)

    rows = (await db.execute(select(PatientCache))).scalars().all()
    items: list[PatientWorklistItem] = []
    for r in rows:
        try:
            items.append(PatientWorklistItem(**(r.cached_payload or {})))
        except Exception:
            logger.warning("Skipping malformed cache row fhir_id=%s", r.fhir_id)
    await log_session_access(db,
                             clinician_id=clinician.id,
                             action="worklist.read",
                             payload={"date": date, "count": len(items)})
    return WorklistResponse(date=date, count=len(items), patients=items)


@router.post("/admin/preload", status_code=status.HTTP_202_ACCEPTED)
async def trigger_preload(
    date: str = Query(default_factory=lambda: datetime.utcnow().strftime("%Y-%m-%d")),
    clinician: Clinician = Depends(get_current_clinician),
) -> dict[str, str]:
    """수동 daily preload — production 에선 EventBridge 가 자동 실행.

    TODO: 실제 boto3 stepfunctions.start_execution(DailyPreloadStateMachine).
    """
    logger.info("Manual preload triggered date=%s by=%s", date, clinician.id)
    return {"status": "queued", "date": date}


@router.post("/admin/cron/preload", status_code=status.HTTP_202_ACCEPTED)
async def cron_preload(
    doctor_id: str = Query(..., description="Cognito 의사 username"),
    date: str = Query(default_factory=lambda: datetime.utcnow().strftime("%Y-%m-%d")),
    worklist_time: str = Query(default="", description="의사 설정 수신시각 HH:MM"),
    x_cron_token: str | None = Header(default=None),
) -> dict[str, str]:
    """EventBridge cron 전용 워크리스트 사전 로딩.

    의사별 수신시각(Cognito custom:worklist_time)에 맞춰 say2-2team-worklist-scheduler
    Lambda 가 호출한다. 사람(clinician) 토큰 대신 공유 시크릿(X-Cron-Token)으로 인증해
    무인 스케줄 호출을 허용한다.

    env: CRON_PRELOAD_TOKEN — Lambda 와 공유하는 시크릿.
    """
    expected = os.environ.get("CRON_PRELOAD_TOKEN", "")
    if not expected or x_cron_token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid or missing cron token")
    logger.info("Cron preload triggered doctor=%s date=%s worklist_time=%s",
                doctor_id, date, worklist_time)
    return {"status": "queued", "doctor_id": doctor_id, "date": date}
