"""의료 데이터 접근 감사 로그 기록.

문서: §5.6, §6.3 — HIPAA / EU AI Act Art. 22 컴플라이언스
모든 환자 데이터 접근은 행 한 줄 INSERT.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from ...shared.db_models import AuditLog

logger = logging.getLogger(__name__)


async def log_session_access(
    db: AsyncSession,
    *,
    clinician_id: str,
    session_id: UUID | str | None = None,
    patient_fhir_id: str | None = None,
    action: str,
    payload: dict[str, Any] | None = None,
    ip_addr: str | None = None,
    user_agent: str | None = None,
) -> None:
    row = AuditLog(
        clinician_id=clinician_id,
        session_id=session_id if session_id is None or isinstance(session_id, UUID) else UUID(str(session_id)),
        patient_fhir_id=patient_fhir_id,
        action=action,
        payload=payload,
        ip_addr=ip_addr,
        user_agent=user_agent,
    )
    db.add(row)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        # 감사 로그 실패가 본 요청을 깨뜨리지 않게 — 로그만 남기고 swallow
        logger.exception("audit_log INSERT failed action=%s clinician=%s",
                         action, clinician_id)
