"""HAPI FHIR REST 호출 wrapper.

문서: §3.5, §6.2 — Frontend 는 HAPI 직접 호출 안 하고 항상 FastAPI 경유.
이유: ① JWT 검증, ② 감사 로그, ③ 캐싱, ④ 데이터 정규화.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class HapiClient:
    def __init__(self, base_url: str, *, token: str | None = None, timeout: float = 10.0):
        if not base_url:
            raise ValueError("HAPI base_url is required")
        headers = {"Accept": "application/fhir+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=headers,
            timeout=httpx.Timeout(timeout, connect=5.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── 환자 ────────────────────────────────────────────────────
    async def get_patient(self, fhir_id: str) -> dict[str, Any]:
        r = await self._client.get(f"/Patient/{fhir_id}")
        r.raise_for_status()
        return r.json()

    async def get_patient_observations(self, fhir_id: str, count: int = 50) -> list[dict[str, Any]]:
        r = await self._client.get(
            "/Observation",
            params={"patient": fhir_id, "_count": count, "_sort": "-date"},
        )
        r.raise_for_status()
        bundle = r.json()
        return [e["resource"] for e in (bundle.get("entry") or []) if e.get("resource")]

    async def get_patient_imaging(self, fhir_id: str, count: int = 20) -> list[dict[str, Any]]:
        r = await self._client.get(
            "/ImagingStudy",
            params={"patient": fhir_id, "_count": count, "_sort": "-started"},
        )
        r.raise_for_status()
        bundle = r.json()
        return [e["resource"] for e in (bundle.get("entry") or []) if e.get("resource")]

    # ── 워크리스트 (오늘 외래) ─────────────────────────────────
    async def get_appointments_for_date(self, date_iso: str) -> list[dict[str, Any]]:
        r = await self._client.get(
            "/Appointment",
            params={"date": date_iso, "_count": 100, "status": "booked"},
        )
        r.raise_for_status()
        bundle = r.json()
        return [e["resource"] for e in (bundle.get("entry") or []) if e.get("resource")]

    # ── 헬스체크 ────────────────────────────────────────────────
    async def metadata(self) -> dict[str, Any]:
        r = await self._client.get("/metadata")
        r.raise_for_status()
        return r.json()
