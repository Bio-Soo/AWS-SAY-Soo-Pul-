"""진단 세션 라우터 — raw asyncpg 사용.

문서: §5.6, §6.3 — Phase 1~5 비동기 파이프라인 트리거 + 폴링 조회.

엔드포인트:
  POST   /api/v1/sessions             · 새 세션 생성 (Step Functions 시작 X)
  POST   /api/v1/sessions/{id}/run    · 파이프라인 실행 시작 (202 Accepted)
  GET    /api/v1/sessions/{id}        · 세션 상태 + Phase 결과 (frontend 가 2초 간격 polling)
  GET    /api/v1/sessions/{id}/result · 최종 통합 리포트
  POST   /api/v1/sessions/{id}/rerun  · 재진단 (새 세션 생성)

SQLAlchemy AsyncSession + asyncpg dialect 의 MissingGreenlet 이슈로 raw asyncpg 사용.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from ...shared.schemas import (
    SessionCreateRequest, SessionCreateResponse,
    SessionDetailResponse, SessionFinalReport, SessionStatus,
)
from ..config import Settings
from ..deps import Clinician, get_current_clinician, get_pg
from ..services.stepfunctions import start_diagnosis_pipeline

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


# ----------------------------------------------------------------
# Status 매핑 (frontend 'created' ↔ DB 'initiated')
# ----------------------------------------------------------------
_FROM_DB_STATUS = {
    "initiated": SessionStatus.created,
    "running":   SessionStatus.running,
    "completed": SessionStatus.completed,
    "failed":    SessionStatus.failed,
    "cancelled": SessionStatus.cancelled,
}


def _settings() -> Settings:
    return Settings.from_env()


def _progress_from_phases(*phases) -> float:
    done = sum(1 for p in phases if p is not None)
    return round(done / max(1, len(phases)), 2)


def _parse_json(value: Any) -> Any:
    """asyncpg 는 JSONB 를 dict/list 로 자동 변환하지만, server_settings 에서 jsonb codec 등록
    안 했으면 string 으로 옴. 둘 다 처리."""
    if value is None or isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return None
    return value


async def _latest_bundle_id(conn: asyncpg.Connection, patient_id: str) -> UUID:
    row = await conn.fetchrow(
        "SELECT bundle_id FROM soopulai.raw_emr_bundle "
        "WHERE patient_id=$1 ORDER BY fetched_at DESC LIMIT 1",
        patient_id,
    )
    if not row:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"No EMR bundle for patient {patient_id} (seed mock-emr first)",
        )
    return row["bundle_id"]


async def _check_session_owner(conn: asyncpg.Connection, session_id: UUID, clinician_id: str):
    row = await conn.fetchrow(
        "SELECT session_id, patient_id, initiated_by, status, current_phase, "
        "initiated_at, completed_at, phase_states "
        "FROM soopulai.diagnosis_session WHERE session_id=$1",
        session_id,
    )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if row["initiated_by"] != clinician_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Forbidden")
    return row


# ================================================================
# POST /sessions  — 새 세션 생성
# ================================================================
@router.post("", response_model=SessionCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreateRequest,
    conn: asyncpg.Connection = Depends(get_pg),
    clinician: Clinician = Depends(get_current_clinician),
) -> SessionCreateResponse:
    bundle_id = await _latest_bundle_id(conn, payload.patient_fhir_id)
    new_session_id = uuid.uuid4()
    phase_states = {
        "frontend_payload": {
            "symptom_text": payload.symptom_text,
            "cxr_s3_key":   payload.cxr_s3_key,
        },
        "execution_arn": None,
    }
    await conn.execute(
        "INSERT INTO soopulai.diagnosis_session "
        "(session_id, patient_id, bundle_id, initiated_by, status, current_phase, phase_states) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        new_session_id, payload.patient_fhir_id, bundle_id,
        clinician.id, "initiated", 0, json.dumps(phase_states),
    )
    return SessionCreateResponse(session_id=str(new_session_id), status=SessionStatus.created)


# ================================================================
# POST /sessions/{id}/run  — Step Functions 실행 시작
# ================================================================
@router.post("/{session_id}/run", status_code=status.HTTP_202_ACCEPTED)
async def run_session(
    session_id: UUID,
    conn: asyncpg.Connection = Depends(get_pg),
    clinician: Clinician = Depends(get_current_clinician),
) -> dict[str, Any]:
    sess = await _check_session_owner(conn, session_id, clinician.id)
    payload_meta = (_parse_json(sess["phase_states"]) or {}).get("frontend_payload", {})

    s = _settings()
    arn = await start_diagnosis_pipeline(
        session_id=str(session_id),
        patient_fhir_id=sess["patient_id"],
        symptom_text=payload_meta.get("symptom_text") or "",
        cxr_s3_key=payload_meta.get("cxr_s3_key"),
        state_machine_arn=s.stepfn_state_machine_arn,
        region=s.aws_region,
    )

    new_states = _parse_json(sess["phase_states"]) or {}
    new_states["execution_arn"] = arn
    await conn.execute(
        "UPDATE soopulai.diagnosis_session "
        "SET status=$1, current_phase=$2, phase_states=$3::jsonb WHERE session_id=$4",
        "running", 1, json.dumps(new_states), session_id,
    )
    return {"status": "started", "execution_arn": arn}


# ================================================================
# GET /sessions/{id}  — 진행상태 + Phase 결과 (2초 polling)
# ================================================================
@router.get("/{session_id}", response_model=SessionDetailResponse)
async def get_session(
    session_id: UUID,
    conn: asyncpg.Connection = Depends(get_pg),
    clinician: Clinician = Depends(get_current_clinician),
) -> SessionDetailResponse:
    sess = await _check_session_owner(conn, session_id, clinician.id)

    p1 = await conn.fetchrow(
        "SELECT positive_hpo, negative_hpo, executed_at FROM soopulai.phase1_hpo_extraction "
        "WHERE session_id=$1 ORDER BY executed_at DESC LIMIT 1", session_id)
    p2 = await conn.fetchrow(
        "SELECT densenet_findings, s3_original_full, executed_at FROM soopulai.phase2_xray_processing "
        "WHERE session_id=$1 ORDER BY executed_at DESC LIMIT 1", session_id)
    p3 = await conn.fetchrow(
        "SELECT ranking, executed_at FROM soopulai.phase3_integrated_ranking "
        "WHERE session_id=$1 ORDER BY executed_at DESC LIMIT 1", session_id)
    p4 = await conn.fetchrow(
        "SELECT reranked, executed_at FROM soopulai.phase4_llm_rerank "
        "WHERE session_id=$1 ORDER BY executed_at DESC LIMIT 1", session_id)
    p5 = await conn.fetchrow(
        "SELECT listed_diseases, total_listed_count, top_lr_score, top_lr_orphacode, "
        "       listing_criteria, rare_db_ver, executed_at FROM soopulai.phase5_rare_disease_listing "
        "WHERE session_id=$1 ORDER BY executed_at DESC LIMIT 1", session_id)

    return SessionDetailResponse(
        session_id=str(session_id),
        patient_fhir_id=sess["patient_id"],
        status=_FROM_DB_STATUS.get(sess["status"], SessionStatus.failed),
        progress=_progress_from_phases(p1, p2, p3, p4, p5),
        phase1=_to_phase1(p1) if p1 else None,
        phase2=_to_phase2(p2) if p2 else None,
        phase3=_to_phase3(p3) if p3 else None,
        phase4=_to_phase4(p4) if p4 else None,
        phase5=_to_phase5(p5) if p5 else None,
        created_at=sess["initiated_at"],
        updated_at=sess["completed_at"] or sess["initiated_at"],
    )


# ================================================================
# GET /sessions/{id}/result  — 최종 RAG 리포트
# ================================================================
@router.get("/{session_id}/result", response_model=SessionFinalReport)
async def get_session_result(
    session_id: UUID,
    conn: asyncpg.Connection = Depends(get_pg),
    clinician: Clinician = Depends(get_current_clinician),
) -> SessionFinalReport:
    sess = await _check_session_owner(conn, session_id, clinician.id)
    final = await conn.fetchrow(
        "SELECT diagnosis_json, markdown_report, rag_citations, rag_apis_used, "
        "       self_check, llm_model, s3_uri_pdf, generated_at "
        "FROM soopulai.final_report "
        "WHERE session_id=$1 ORDER BY generated_at DESC LIMIT 1",
        session_id,
    )
    if not final:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Final report not yet ready. Poll /sessions/{id} until status=completed.",
        )

    diag = _parse_json(final["diagnosis_json"]) or {}
    final_dx = diag.get("final_dx") or diag.get("primary_diagnosis")
    confidence = diag.get("confidence")

    from ...shared.schemas import RagCitation
    raw_cit = _parse_json(final["rag_citations"]) or []
    citations = [RagCitation(**c) for c in raw_cit if isinstance(c, dict)]
    md = final["markdown_report"] or ""

    return SessionFinalReport(
        session_id=str(session_id),
        patient_fhir_id=sess["patient_id"],
        final_dx=final_dx,
        confidence=confidence,
        diagnosis_json=diag,
        markdown_report=md,
        full_report_md=md,
        rag_citations=citations,
        rag_apis_used=list(_parse_json(final["rag_apis_used"]) or []),
        self_check=_parse_json(final["self_check"]),
        llm_model=final["llm_model"],
        s3_uri_pdf=final["s3_uri_pdf"],
        generated_at=final["generated_at"],
    )


# ================================================================
# POST /sessions/{id}/rerun  — 같은 환자/증상으로 새 세션
# ================================================================
@router.post("/{session_id}/rerun",
             response_model=SessionCreateResponse,
             status_code=status.HTTP_201_CREATED)
async def rerun_session(
    session_id: UUID,
    conn: asyncpg.Connection = Depends(get_pg),
    clinician: Clinician = Depends(get_current_clinician),
) -> SessionCreateResponse:
    orig = await _check_session_owner(conn, session_id, clinician.id)
    orig_payload = (_parse_json(orig["phase_states"]) or {}).get("frontend_payload", {})

    # bundle_id 도 동일 환자의 최신 bundle 사용
    bundle_id = await _latest_bundle_id(conn, orig["patient_id"])

    new_id = uuid.uuid4()
    new_states = {
        "frontend_payload": orig_payload,
        "execution_arn": None,
        "rerun_of": str(session_id),
    }
    await conn.execute(
        "INSERT INTO soopulai.diagnosis_session "
        "(session_id, patient_id, bundle_id, initiated_by, status, current_phase, phase_states) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        new_id, orig["patient_id"], bundle_id, clinician.id,
        "initiated", 0, json.dumps(new_states),
    )
    return SessionCreateResponse(session_id=str(new_id), status=SessionStatus.created)


# ================================================================
# Row(dict-like) → Pydantic schemas 변환
# ================================================================
def _to_phase1(p):
    from ...shared.schemas import Phase1Result as S
    return S(
        positive_hpo=_parse_json(p["positive_hpo"]) or [],
        negative_hpo=_parse_json(p["negative_hpo"]) or [],
        extracted_at=p["executed_at"],
    )


def _to_phase2(p):
    """phase2_xray_processing.densenet_findings → Phase2Result.findings.

    Lambda 가 INSERT 하는 실제 형식 (5/19 확인):
      {"Atelectasis": {"hpo_code": "HP:0002095", "probability": 0.3548}, ...}

    Legacy / 다른 형식도 흡수:
      list[{"label","score"}]            — flat array
      {"label": score}                   — dict[str, float]
    """
    from ...shared.schemas import Phase2Finding, Phase2Result as S
    raw = _parse_json(p["densenet_findings"]) or []
    findings: list[Phase2Finding] = []

    def _add(label: str, score, hpo=None):
        try:
            findings.append(Phase2Finding(
                label=str(label),
                score=float(score),
                hpo_code=hpo,
            ))
        except (TypeError, ValueError):
            pass

    if isinstance(raw, list):
        for f in raw:
            if isinstance(f, dict) and "label" in f and "score" in f:
                _add(f["label"], f["score"], f.get("hpo_code"))
    elif isinstance(raw, dict):
        # Lambda 의 실제 출력 — dict[label, {hpo_code, probability}]
        for k, v in raw.items():
            if isinstance(v, dict):
                prob = v.get("probability", v.get("score", 0))
                _add(k, prob, v.get("hpo_code") or v.get("hpo"))
            else:
                _add(k, v)

    return S(findings=findings, cxr_s3_key=p["s3_original_full"], inferred_at=p["executed_at"])


def _to_phase3(p):
    from ...shared.schemas import Phase3LRScore, Phase3Result as S
    raw = _parse_json(p["ranking"]) or []
    cands: list[Phase3LRScore] = []
    for d in (raw if isinstance(raw, list) else []):
        if not isinstance(d, dict):
            continue
        name = d.get("name") or d.get("name_kr") or d.get("disease_key") or d.get("disease_id") or ""
        name_en = d.get("name_en") or d.get("english_name") or None
        orpha = d.get("orpha_code") or d.get("orphacode") or d.get("orpha")
        score = d.get("lr_score") or d.get("score") or d.get("total_score") or 0.0
        try:
            cands.append(Phase3LRScore(orpha_code=orpha,
                                       name=str(name),
                                       name_en=str(name_en) if name_en else None,
                                       lr_score=float(score)))
        except (TypeError, ValueError):
            continue
    return S(top_candidates=cands[:10], computed_at=p["executed_at"])


def _to_phase4(p):
    from ...shared.schemas import Phase4Result as S, Phase4Verification
    raw = _parse_json(p["reranked"]) or []
    vs: list[Phase4Verification] = []
    for v in (raw if isinstance(raw, list) else []):
        if not isinstance(v, dict):
            continue
        cand = v.get("candidate") or v.get("disease_key") or v.get("name") or ""
        conf = (v.get("confidence") or "MEDIUM").upper()
        ev = v.get("evidence") or v.get("reasoning") or []
        if isinstance(ev, str):
            ev = [ev]
        try:
            vs.append(Phase4Verification(candidate=str(cand),
                                         confidence=conf,
                                         evidence=list(ev) if isinstance(ev, list) else []))
        except (TypeError, ValueError):
            continue
    return S(verifications=vs, verified_at=p["executed_at"])


def _to_phase5(p):
    from ...shared.schemas import Phase5Result as S, RareDiseaseListing
    raw = _parse_json(p["listed_diseases"]) or []
    listed = []
    for d in (raw if isinstance(raw, list) else []):
        if not isinstance(d, dict):
            continue
        try:
            listed.append(RareDiseaseListing(**d))
        except Exception:
            continue
    top_lr = p["top_lr_score"]
    return S(
        listed_diseases=listed,
        total_listed_count=p["total_listed_count"] or len(listed),
        top_lr_score=float(top_lr) if top_lr is not None else None,
        top_lr_orphacode=p["top_lr_orphacode"],
        listing_criteria=_parse_json(p["listing_criteria"]) or {},
        rare_db_version=p["rare_db_ver"],
        executed_at=p["executed_at"],
    )
