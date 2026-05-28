"""환자 정보 라우터 — HAPI FHIR proxy + cache.

문서: §6.2 — Frontend 는 HAPI 직접 호출 안 함. 모든 환자 데이터 접근은 FastAPI 경유.
이유: ① JWT 검증, ② 감사 로그, ③ 캐싱, ④ 데이터 정규화

엔드포인트:
  GET  /api/v1/patients/{fhir_id}   · 환자 detail (cache hit 우선, miss 시 HAPI fetch)
  POST /api/v1/patients/import      · HAPI 에서 강제 재 fetch + cache 갱신
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ...shared.db_models import FhirBundleArchive, PatientCache
from ...shared.schemas import PatientDetail
from ..config import Settings
from ..deps import Clinician, get_current_clinician, get_db
from ..services import s3_emr
from ..services.audit_log import log_session_access
from ..services.hapi_client import HapiClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/patients", tags=["patients"])


class PatientImportRequest(BaseModel):
    patient_fhir_id: str


def _settings() -> Settings:
    return Settings.from_env()


@router.get("/{fhir_id}", response_model=PatientDetail)
async def get_patient(
    fhir_id: str,
    db: AsyncSession = Depends(get_db),
    clinician: Clinician = Depends(get_current_clinician),
) -> PatientDetail:
    s = _settings()
    # ── s3-mock: 정적 JSON 직접 fetch (데모) ─────────────────────
    if s.emr_data_source == "s3-mock":
        payload = s3_emr.get_patient(fhir_id)
        if payload is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                f"Patient {fhir_id} not found in mock EMR")
        return PatientDetail(**payload)

    # ── hapi (기본): DB cache hit ────────────────────────────────
    cache: PatientCache | None = await db.get(PatientCache, fhir_id)
    if cache is None or cache.cached_payload is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Patient not in cache. POST /patients/import first.",
        )
    await log_session_access(db,
                             clinician_id=clinician.id,
                             patient_fhir_id=fhir_id,
                             action="patient.read")
    return PatientDetail(**cache.cached_payload)


@router.post("/import", response_model=PatientDetail, status_code=status.HTTP_201_CREATED)
async def import_patient(
    body: PatientImportRequest,
    db: AsyncSession = Depends(get_db),
    clinician: Clinician = Depends(get_current_clinician),
) -> PatientDetail:
    """HAPI 에서 환자 정보 fetch → 정규화 → cache 저장."""
    s = _settings()
    if not s.fhir_base_url:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "FHIR_BASE_URL not configured")

    hapi = HapiClient(s.fhir_base_url, token=s.fhir_auth_token)
    try:
        patient_resource = await hapi.get_patient(body.patient_fhir_id)
        observations = await hapi.get_patient_observations(body.patient_fhir_id)
        imaging = await hapi.get_patient_imaging(body.patient_fhir_id)
    finally:
        await hapi.aclose()

    # 정규화 (FHIR → PatientDetail) — 실 구현은 lung_dx/api/fhirAdapter 와 같은 변환 로직
    normalized = _normalize_patient(patient_resource, observations, imaging)

    # cache 갱신
    cache: PatientCache | None = await db.get(PatientCache, body.patient_fhir_id)
    if cache is None:
        cache = PatientCache(fhir_id=body.patient_fhir_id, cached_payload=normalized.model_dump(mode="json"),
                             last_synced=datetime.utcnow())
        db.add(cache)
    else:
        cache.cached_payload = normalized.model_dump(mode="json")
        cache.last_synced = datetime.utcnow()

    # 원본 Bundle archive
    db.add(FhirBundleArchive(
        fhir_id=body.patient_fhir_id,
        bundle={"patient": patient_resource, "observations": observations, "imaging": imaging},
    ))

    await db.commit()
    await log_session_access(db,
                             clinician_id=clinician.id,
                             patient_fhir_id=body.patient_fhir_id,
                             action="patient.import")
    return normalized


import re

_HANGUL = re.compile(r"[가-힣]")


def _mask_name(human_name: dict[str, Any] | None) -> str:
    """Frontend fhirAdapter.maskName() 와 1:1 일치 매핑.

    - 한글 family → '김○○'
    - 영문 family + given → 'John S.'
    - 둘 다 빈 값이면 humanName.text → '환자'.
    R4: family=string, given=string[]. STU3 fallback: family 가 배열일 수 있음.
    """
    if not human_name:
        return "환자"
    f_raw = human_name.get("family")
    g_raw = human_name.get("given")
    family = (f_raw[0] if isinstance(f_raw, list) else (f_raw or "")).strip()
    given  = (g_raw[0] if isinstance(g_raw, list) else (g_raw or "")).strip()

    if family and _HANGUL.search(family):
        return f"{family[0]}○○"
    if given and family:
        return f"{given} {family[0]}."
    if family:
        return family
    if given:
        return given
    return human_name.get("text") or "환자"


# Frontend fhirAdapter.LOINC_TO_LAB 와 동일.
_LOINC_TO_LAB = {
    "2532-0":  "LDH",
    "1988-5":  "CRP",
    "94508-9": "KL-6",
    "20448-7": "SP-D",
}

# 카테고리별 LOINC 코드 (Synthea 기본 항목 위주).
_LOINC_BY_CATEGORY: dict[str, list[tuple[str, str]]] = {
    "cbc": [
        ("6690-2",  "WBC"),
        ("718-7",   "Hb"),
        ("4544-3",  "Hct"),
        ("777-3",   "Plt"),
        ("731-0",   "Lymphocyte"),
        ("770-8",   "Neutrophil%"),
        ("711-2",   "Eosinophil%"),
    ],
    "chem": [
        ("3094-0",  "BUN"),
        ("2160-0",  "Cr"),
        ("48642-3", "eGFR"),
        ("2951-2",  "Na"),
        ("2823-3",  "K"),
        ("1920-8",  "AST"),
        ("1742-6",  "ALT"),
        ("2345-7",  "Glucose"),
        ("30934-4", "BNP"),
    ],
    "abg": [
        ("2744-1",  "pH"),
        ("2703-7",  "PaO2"),
        ("2019-8",  "PaCO2"),
        ("1959-6",  "HCO3"),
        ("2708-6",  "SaO2"),
        ("2524-7",  "Lactate"),
    ],
    "inflam": [
        ("1988-5",  "CRP"),
        ("4537-7",  "ESR"),
        ("94508-9", "KL-6"),
        ("20448-7", "SP-D"),
        ("2532-0",  "LDH"),
    ],
}


def _row_from_obs(obs: dict[str, Any], label: str) -> dict[str, Any]:
    """단일 FHIR Observation → LabRow shape."""
    vq = obs.get("valueQuantity") or {}
    value = vq.get("value")
    unit  = vq.get("unit") or vq.get("code") or ""
    refs  = obs.get("referenceRange") or []
    ref_str = ""
    if refs:
        lo = refs[0].get("low", {}).get("value")
        hi = refs[0].get("high", {}).get("value")
        if lo is not None and hi is not None:
            ref_str = f"{lo}–{hi}"
        elif refs[0].get("text"):
            ref_str = refs[0]["text"]
    interp = (obs.get("interpretation") or [{}])[0].get("coding", [{}])[0].get("code", "")
    flag = {"H": "high", "HH": "critical", "L": "low", "LL": "critical"}.get(interp)
    return {
        "name":  label,
        "value": "" if value is None else str(value),
        "unit":  unit,
        "range": ref_str,
        "flag":  flag,
    }


def _observation_loinc(obs: dict[str, Any]) -> str | None:
    for c in (obs.get("code", {}).get("coding") or []):
        if c.get("system") == "http://loinc.org" and c.get("code"):
            return c["code"]
    return None


def _group_lab_panels(observations: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """카테고리별로 묶고, 같은 시점(effectiveDateTime ~분 단위)을 한 panel 로 합침."""
    out: dict[str, list[dict[str, Any]]] = {"cbc": [], "chem": [], "abg": [], "inflam": []}
    # category → {time_key → panel}
    bucket: dict[str, dict[str, dict[str, Any]]] = {k: {} for k in out}

    for obs in observations:
        loinc = _observation_loinc(obs)
        if loinc is None:
            continue
        for cat, mapping in _LOINC_BY_CATEGORY.items():
            label = next((lab for code, lab in mapping if code == loinc), None)
            if label is None:
                continue
            t = obs.get("effectiveDateTime") or obs.get("issued")
            if not t:
                continue
            # 분 단위로 truncate — 같은 채혈건 통합
            key = t[:16]
            panel = bucket[cat].setdefault(key, {
                "collectedAt": obs.get("effectiveDateTime"),
                "resultedAt":  obs.get("issued"),
                "rows": [],
            })
            panel["rows"].append(_row_from_obs(obs, label))
            break

    # 시점 내림차순 (최신 우선)
    for cat, panels in bucket.items():
        out[cat] = [panels[k] for k in sorted(panels.keys(), reverse=True)]
    return out


def _vitals_history(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """BP/HR/RR/SpO₂/Temp 를 effectiveDateTime 으로 묶어 한 줄 string 으로."""
    # LOINC: 85354-9 BP panel · 8867-4 HR · 9279-1 RR · 2708-6 SpO2 · 8310-5 Temp
    buckets: dict[str, dict[str, str]] = {}
    for obs in observations:
        loinc = _observation_loinc(obs)
        if loinc is None:
            continue
        t = obs.get("effectiveDateTime")
        if not t:
            continue
        key = t[:16]
        b = buckets.setdefault(key, {"_t": t})
        if loinc == "55284-4":  # BP panel
            sys_v = dia_v = None
            for comp in (obs.get("component") or []):
                code = (comp.get("code", {}).get("coding", [{}])[0]).get("code")
                v = comp.get("valueQuantity", {}).get("value")
                if code == "8480-6": sys_v = v
                if code == "8462-4": dia_v = v
            if sys_v and dia_v:
                b["BP"] = f"BP {int(sys_v)}/{int(dia_v)}"
        elif loinc == "8867-4":
            v = obs.get("valueQuantity", {}).get("value")
            if v: b["HR"] = f"HR {int(v)}"
        elif loinc == "9279-1":
            v = obs.get("valueQuantity", {}).get("value")
            if v: b["RR"] = f"RR {int(v)}"
        elif loinc == "2708-6":
            v = obs.get("valueQuantity", {}).get("value")
            if v: b["SpO2"] = f"SpO₂ {int(v)}% (RA)"
        elif loinc == "8310-5":
            v = obs.get("valueQuantity", {}).get("value")
            if v: b["T"] = f"T {v:.1f}°C"

    out = []
    for key in sorted(buckets.keys(), reverse=True):
        b = buckets[key]
        parts = [b.get(k) for k in ("BP", "HR", "RR", "SpO2", "T") if b.get(k)]
        if not parts:
            continue
        out.append({"measuredAt": b["_t"], "vitals": " · ".join(parts)})
    return out


def _normalize_patient(patient: dict[str, Any],
                       observations: list[dict[str, Any]],
                       imaging: list[dict[str, Any]]) -> PatientDetail:
    """FHIR resource → PatientDetail.

    Frontend `fhirAdapter.toUIShape()` 와 동일 매핑. 함수 명세:
      - 이름 마스킹 (한글: 김○○ / 영문: John S.)
      - sex/age 산출
      - CxrStudy 변환 (ImagingStudy[])
      - LabPanelsByCategory (cbc/chem/abg/inflam) 그룹핑
      - VitalsEntry 시점별 한 줄 string 합성
    """
    from ...shared.schemas import (
        CxrStudy, LabPanelsByCategory, VitalsEntry,
    )

    masked = _mask_name((patient.get("name") or [{}])[0])
    sex = {"male": "M", "female": "F"}.get(patient.get("gender", ""), "?")

    birth = patient.get("birthDate")
    age = 0
    if birth:
        try:
            age = (datetime.utcnow() - datetime.fromisoformat(birth)).days // 365
        except Exception:
            pass

    cxr_studies = [
        CxrStudy(
            studyId=s.get("id", ""),
            capturedAt=s.get("started"),
            view=(s.get("series") or [{}])[0].get("bodySite", {}).get("display", "PA · Frontal"),
            modality=(s.get("modality") or [{}])[0].get("code", "CR"),
        )
        for s in imaging
    ]

    lab_groups = _group_lab_panels(observations)
    labs = LabPanelsByCategory(
        cbc=lab_groups["cbc"], chem=lab_groups["chem"],
        abg=lab_groups["abg"], inflam=lab_groups["inflam"],
    )

    vitals_history = [VitalsEntry(**v) for v in _vitals_history(observations)]
    vitals_str = vitals_history[0].vitals if vitals_history else None

    return PatientDetail(
        mrn=patient.get("id", ""),
        name=masked,
        sex=sex,
        age=age,
        time=datetime.now().strftime("%H:%M"),
        visit="재진",
        complaint="",
        allergy=None,
        cxr="arrived" if imaging else "pending",
        status="ready",
        rare=False,
        dontMiss=False,
        acknowledged=None,
        pendingEmrUpdates=0,
        topDx=None,
        preview=None,
        vitals=vitals_str,
        vitalsHistory=vitals_history,
        labs=labs,
        cxrStudies=cxr_studies,
    )
