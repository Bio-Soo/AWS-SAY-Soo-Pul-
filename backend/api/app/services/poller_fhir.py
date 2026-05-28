"""실제 FHIR 서버 polling.

전략:
  - POLL_INTERVAL 마다 GET <FHIR_BASE_URL>/Observation?_lastUpdated=gt<since>&_summary=count
    (count-only · 가벼움. 새 리소스가 있으면 본 쿼리로 상세 fetch)
  - 환자 MRN 별이 아니라 전체 사이트 단위로 변경 감지 → 환자별 카운트 집계
  - 인증: FHIR_AUTH_TOKEN 환경변수가 있으면 Authorization: Bearer 부착
  - 에러: 네트워크 실패는 로그만 남기고 다음 tick 으로 (poller 가 죽으면 안 됨)

향후 마이그레이션:
  - W4 후반에 FHIR Subscription (R4B/R5) 으로 교체 가능. 같은 emit() 인터페이스 유지.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

from ..config import Settings

logger = logging.getLogger(__name__)

EmitFn = Callable[[str | None, dict], Awaitable[int]]

# 추적할 리소스 타입 (Observation = vital + lab, ImagingStudy = CXR)
_RESOURCES = ["Observation", "ImagingStudy", "Condition"]


def _iso(dt: datetime) -> str:
    """FHIR _lastUpdated 비교용 ISO8601 (Z suffix)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _patient_ref(resource: dict[str, Any]) -> str | None:
    """resource.subject.reference 또는 resource.patient.reference 에서 'Patient/<id>' 추출."""
    for key in ("subject", "patient"):
        ref = (resource.get(key) or {}).get("reference") or ""
        if ref.startswith("Patient/"):
            return ref.split("/", 1)[1]
    return None


def _category(resource: dict[str, Any]) -> str:
    """Observation 의 category.coding[].code 로 vital/lab 판별."""
    rt = resource.get("resourceType")
    if rt == "ImagingStudy":
        return "cxr"
    if rt == "Condition":
        return "condition"
    if rt == "Observation":
        cats = resource.get("category") or []
        for c in cats:
            for coding in (c.get("coding") or []):
                code = (coding.get("code") or "").lower()
                if "vital" in code:
                    return "vital"
                if "lab" in code:
                    return "lab"
        return "observation"
    return rt or "unknown"


class FhirPoller:
    def __init__(self, settings: Settings, emit: EmitFn) -> None:
        if not settings.fhir_base_url:
            raise ValueError("FHIR_BASE_URL 미설정 (POLL_MODE=fhir 일 땐 필수)")
        self._settings = settings
        self._emit = emit
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._since: datetime = datetime.now(tz=timezone.utc)
        self._client: httpx.AsyncClient | None = None

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/fhir+json"}
        if self._settings.fhir_auth_token:
            h["Authorization"] = f"Bearer {self._settings.fhir_auth_token}"
        return h

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopped.clear()
        self._client = httpx.AsyncClient(
            base_url=self._settings.fhir_base_url.rstrip("/"),
            headers=self._headers(),
            timeout=httpx.Timeout(10.0, connect=5.0),
        )
        self._task = asyncio.create_task(self._run(), name="fhir-poller")
        logger.info("FhirPoller started · interval=%.1fs base=%s",
                    self._settings.poll_interval_sec, self._settings.fhir_base_url)

    async def stop(self) -> None:
        self._stopped.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        if self._client:
            await self._client.aclose()
        logger.info("FhirPoller stopped")

    async def _run(self) -> None:
        try:
            while not self._stopped.is_set():
                try:
                    await asyncio.wait_for(self._stopped.wait(),
                                           timeout=self._settings.poll_interval_sec)
                    return
                except asyncio.TimeoutError:
                    pass
                try:
                    await self._poll_once()
                except Exception:
                    logger.exception("FhirPoller tick failed (계속 진행)")
        except asyncio.CancelledError:
            raise

    async def _poll_once(self) -> None:
        """한 번의 polling: 변경 리소스 fetch → 환자별 집계 → emit."""
        assert self._client is not None
        since_iso = _iso(self._since)
        new_since = datetime.now(tz=timezone.utc)

        # 환자별 → 카테고리별 카운트
        per_patient: dict[str, dict[str, int]] = {}

        for rtype in _RESOURCES:
            try:
                # 모든 매치 fetch (count 가 많으면 페이지네이션 필요 — 1차 구현은 _count=50 로 cap)
                r = await self._client.get(
                    f"/{rtype}",
                    params={"_lastUpdated": f"gt{since_iso}", "_count": 50, "_sort": "-_lastUpdated"},
                )
                r.raise_for_status()
                bundle = r.json()
            except Exception as e:
                logger.warning("FhirPoller %s fetch failed: %s", rtype, e)
                continue

            for entry in (bundle.get("entry") or []):
                res = entry.get("resource") or {}
                pid = _patient_ref(res)
                if not pid:
                    continue
                cat = _category(res)
                per_patient.setdefault(pid, {}).setdefault(cat, 0)
                per_patient[pid][cat] += 1

        # 환자별로 emit
        for pid, cats in per_patient.items():
            delta = [{"resource": "Observation" if c in ("vital", "lab") else c.title(),
                      "category": c, "count": n}
                     for c, n in cats.items()]
            pending_delta = sum(cats.values())
            payload = {
                "type": "emr-update",
                "mrn": pid,
                "pendingDelta": pending_delta,
                "delta": delta,
                "since": since_iso,
                "now":   _iso(new_since),
            }
            sent = await self._emit(pid, payload)
            logger.info("FhirPoller patient=%s delta=%d → %d clients", pid, pending_delta, sent)

        if not per_patient:
            logger.debug("FhirPoller poll @ %s · no new resources", since_iso)

        self._since = new_since
