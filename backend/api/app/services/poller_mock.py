"""시연용 mock 이벤트 emitter.

- POLL_INTERVAL 마다 MOCK_PATIENT_MRNS 중 한 명에게 +1 pending update 발생
- 신뢰성: 결정론적 라운드로빈 + 매 4번째에 'no-changes' 1회 (실제 EMR 의 idle 흉내)

emit 형식 (broadcast 시 ConnectionManager 가 그대로 push):
    {
      "type": "emr-update",
      "mrn": "20-145982",
      "pendingDelta": 1,                // +N 건이 새로 생겼다
      "delta": [{"resource": "Observation", "category": "vital", "count": 1}],
      "since": "...",
      "now":   "..."
    }
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from itertools import cycle
from typing import Awaitable, Callable

from ..config import Settings

logger = logging.getLogger(__name__)

EmitFn = Callable[[str | None, dict], Awaitable[int]]

# 라운드로빈 카테고리 (실 EMR 처럼 다양한 리소스가 들어옴)
_DELTA_CYCLE = cycle([
    [{"resource": "Observation", "category": "vital", "count": 1}],
    [{"resource": "Observation", "category": "lab",   "count": 1}],
    [{"resource": "ImagingStudy", "category": "cxr",  "count": 1}],
    [{"resource": "Observation", "category": "vital", "count": 1},
     {"resource": "Observation", "category": "lab",   "count": 1}],
])


class MockPoller:
    """가짜 이벤트 polling task.

    한 번 start() 하면 stop() 호출까지 인터벌마다 MRN 한 명을 골라 broadcast.
    """

    def __init__(self, settings: Settings, emit: EmitFn) -> None:
        if not settings.mock_patient_mrns:
            raise ValueError("MOCK_PATIENT_MRNS 가 비어있음 (config 확인)")
        self._settings = settings
        self._emit = emit
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._mrn_cycle = cycle(settings.mock_patient_mrns)
        self._tick = 0
        self._since = datetime.now(tz=timezone.utc)

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run(), name="mock-poller")
        logger.info("MockPoller started · interval=%.1fs MRNs=%s",
                    self._settings.poll_interval_sec, list(self._settings.mock_patient_mrns))

    async def stop(self) -> None:
        self._stopped.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        logger.info("MockPoller stopped")

    async def _run(self) -> None:
        try:
            while not self._stopped.is_set():
                try:
                    await asyncio.wait_for(self._stopped.wait(),
                                           timeout=self._settings.poll_interval_sec)
                    return  # stopped
                except asyncio.TimeoutError:
                    pass  # interval elapsed → emit

                self._tick += 1
                # 매 4번째 tick 은 idle (no-changes) — 실 EMR idle 흉내
                if self._tick % 4 == 0:
                    logger.debug("MockPoller tick=%d → idle (no event)", self._tick)
                    continue

                mrn = next(self._mrn_cycle)
                delta = next(_DELTA_CYCLE)
                pending_delta = sum(d.get("count", 0) for d in delta)
                now = datetime.now(tz=timezone.utc)
                payload = {
                    "type": "emr-update",
                    "mrn": mrn,
                    "pendingDelta": pending_delta,
                    "delta": delta,
                    "since": self._since.isoformat(),
                    "now":   now.isoformat(),
                }
                self._since = now
                sent = await self._emit(mrn, payload)
                logger.info("MockPoller tick=%d mrn=%s delta=%d → %d clients",
                            self._tick, mrn, pending_delta, sent)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("MockPoller crashed")
            raise
