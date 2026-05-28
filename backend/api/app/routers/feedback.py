"""의사 피드백 라우터.

문서: §5.6 — 진단 결과에 대한 의사의 정/오 피드백 저장.
HITL (EU AI Act Art. 22) · 모델 개선용 시그널.

Frontend payload (schemas.FeedbackCreate) → DB physician_feedback 매핑:
  final_dx_correct → agreed_with_top1
  correction       → selected_diagnosis
  note             → freeform_comment
  clinician.id     → physician_id
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ...shared.db_models import DiagnosisSession, Feedback
from ...shared.schemas import FeedbackCreate
from ..deps import Clinician, get_current_clinician, get_db
from ..services.audit_log import log_session_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/feedback", tags=["feedback"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_feedback(
    payload: FeedbackCreate,
    db: AsyncSession = Depends(get_db),
    clinician: Clinician = Depends(get_current_clinician),
) -> dict[str, str]:
    try:
        sess_uuid = UUID(payload.session_id)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid session_id")

    sess: DiagnosisSession | None = await db.get(DiagnosisSession, sess_uuid)
    if sess is None or sess.initiated_by != clinician.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    fb = Feedback(
        session_id=sess_uuid,
        physician_id=clinician.id,
        agreed_with_top1=payload.final_dx_correct,
        selected_diagnosis=payload.correction,
        freeform_comment=payload.note,
    )
    db.add(fb)
    await db.commit()
    await db.refresh(fb)

    await log_session_access(db,
                             clinician_id=clinician.id,
                             session_id=sess_uuid,
                             action="feedback.create",
                             payload={"agreed": payload.final_dx_correct})

    return {"feedback_id": str(fb.feedback_id), "status": "saved"}
