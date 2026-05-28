"""Phase 결과 INSERT 헬퍼 — Lambda 측에서도 import.

각 Phase Lambda 가 Step Functions 안에서 결과를 DB 에 직접 쓸 때 사용.
main backend 가 polling 으로 같은 테이블을 조회 → 진행률 표시.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from .db_models import (
    DiagnosisSession,
    FinalRagReport,
    Phase1Result,
    Phase2Result,
    Phase3Result,
    Phase4Result,
    Phase5Result,
)


async def write_phase1(db: AsyncSession, session_id: UUID, *,
                       positive_hpo: list[str],
                       negative_hpo: list[str],
                       raw_response: dict[str, Any] | None = None) -> Phase1Result:
    row = Phase1Result(session_id=session_id, positive_hpo=positive_hpo,
                       negative_hpo=negative_hpo, raw_response=raw_response)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def write_phase2(db: AsyncSession, session_id: UUID, *,
                       findings: list[dict[str, Any]],
                       cxr_s3_key: str | None = None,
                       model_version: str | None = None) -> Phase2Result:
    row = Phase2Result(session_id=session_id, findings=findings,
                       cxr_s3_key=cxr_s3_key, model_version=model_version)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def write_phase3(db: AsyncSession, session_id: UUID, *,
                       lr_scores: list[dict[str, Any]],
                       candidates_total: int = 0) -> Phase3Result:
    row = Phase3Result(session_id=session_id, lr_scores=lr_scores,
                       candidates_total=candidates_total)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def write_phase4(db: AsyncSession, session_id: UUID, *,
                       verifications: list[dict[str, Any]],
                       raw_response: dict[str, Any] | None = None) -> Phase4Result:
    row = Phase4Result(session_id=session_id, verifications=verifications,
                       raw_response=raw_response)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def write_phase5(db: AsyncSession, session_id: UUID, *,
                       citations: list[dict[str, Any]],
                       summary_text: str | None = None) -> Phase5Result:
    row = Phase5Result(session_id=session_id, citations=citations,
                       summary_text=summary_text)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def write_final_report(db: AsyncSession, session_id: UUID, *,
                             final_dx: str | None,
                             confidence: str | None,
                             full_report_md: str) -> FinalRagReport:
    row = FinalRagReport(session_id=session_id, final_dx=final_dx,
                         confidence=confidence, full_report_md=full_report_md)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def update_session_status(db: AsyncSession, session_id: UUID, *,
                                status: str,
                                execution_arn: str | None = None) -> None:
    sess: DiagnosisSession | None = await db.get(DiagnosisSession, session_id)
    if sess is None:
        return
    sess.status = status
    if execution_arn:
        sess.execution_arn = execution_arn
    sess.updated_at = datetime.utcnow()
    await db.commit()
