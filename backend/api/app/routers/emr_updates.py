"""EMR 갱신 알림 — WebSocket endpoint + 폴링 task 부착.

문서 §6.3 (2초 폴링) 의 보충: 진단 진행 폴링과 별개로, EMR 에 새 환자
데이터가 도착했음을 즉시 알리기 위한 push 채널. (Frontend EmrUpdateButton 의 빨간 배지)

사용 (api/app/main.py 에서):
    from .routers.emr_updates import setup_emr_updates
    setup_emr_updates(app)
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect

from ..config import Settings
from ..services.poller_fhir import FhirPoller
from ..services.poller_mock import MockPoller
from ..services.ws_connections import ConnectionManager

logger = logging.getLogger(__name__)


def setup_emr_updates(app: FastAPI) -> None:
    """FastAPI app 에 WebSocket endpoint + lifespan 폴링 task 등록."""
    settings = Settings.from_env()
    manager = ConnectionManager()

    poller: MockPoller | FhirPoller
    if settings.poll_mode == "mock":
        poller = MockPoller(settings, manager.broadcast)
    else:
        poller = FhirPoller(settings, manager.broadcast)

    @app.on_event("startup")
    async def _start_poller() -> None:
        logger.info("Starting EMR poller mode=%s", settings.poll_mode)
        await poller.start()

    @app.on_event("shutdown")
    async def _stop_poller() -> None:
        await poller.stop()

    @app.websocket(settings.ws_path)
    async def emr_updates_ws(
        ws: WebSocket,
        mrn: str | None = Query(default=None, max_length=64),
    ) -> None:
        channel = await manager.connect(ws, mrn)
        await ws.send_json({
            "type": "hello",
            "channel": channel,
            "mode": settings.poll_mode,
            "intervalSec": settings.poll_interval_sec,
        })
        try:
            while True:
                msg = await ws.receive_text()
                if msg == "ping":
                    await ws.send_text("pong")
                else:
                    logger.debug("WS recv unknown channel=%s msg=%r", channel, msg[:120])
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("WS handler crashed channel=%s", channel)
        finally:
            await manager.disconnect(ws, channel)

    @app.get("/api/v1/emr-updates/health", tags=["emr-updates"])
    async def emr_health() -> dict[str, Any]:
        return {
            "ok": True,
            "mode": settings.poll_mode,
            "intervalSec": settings.poll_interval_sec,
            "channels": manager.channel_count(),
            "totalClients": manager.total_clients(),
        }
