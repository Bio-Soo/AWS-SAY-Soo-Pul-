"""WebSocket 연결 관리.

여러 브라우저 탭이 같은 환자(MRN)를 보고 있을 수 있어 MRN 별 list 로 보관.
공통 글로벌 채널(MRN 미지정)도 지원 — Worklist 화면용.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

GLOBAL_CHANNEL = "*"


class ConnectionManager:
    """MRN → list[WebSocket] 매핑. 동시 broadcast 용."""

    def __init__(self) -> None:
        self._clients: dict[str, list[WebSocket]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket, mrn: str | None) -> str:
        await ws.accept()
        channel = mrn or GLOBAL_CHANNEL
        async with self._lock:
            self._clients[channel].append(ws)
        logger.info("WS connect channel=%s total=%d", channel, len(self._clients[channel]))
        return channel

    async def disconnect(self, ws: WebSocket, channel: str) -> None:
        async with self._lock:
            if ws in self._clients.get(channel, []):
                self._clients[channel].remove(ws)
            if channel in self._clients and not self._clients[channel]:
                del self._clients[channel]
        logger.info("WS disconnect channel=%s remaining=%d",
                    channel, len(self._clients.get(channel, [])))

    async def broadcast(self, mrn: str | None, payload: dict[str, Any]) -> int:
        """해당 MRN 의 모든 클라이언트 + 글로벌 채널에 push. 보낸 수 반환."""
        channels = [c for c in (mrn, GLOBAL_CHANNEL) if c is not None]
        sent = 0
        async with self._lock:
            targets: list[WebSocket] = []
            for c in channels:
                targets.extend(self._clients.get(c, []))
        msg = json.dumps(payload, ensure_ascii=False)
        # send 는 lock 밖에서 (느린 클라이언트가 다른 broadcast 막지 않게)
        dead: list[tuple[str, WebSocket]] = []
        for ws in targets:
            try:
                await ws.send_text(msg)
                sent += 1
            except Exception as e:
                logger.warning("WS send failed: %s — marking dead", e)
                # find which channel it belonged to
                for c in channels:
                    if ws in self._clients.get(c, []):
                        dead.append((c, ws))
                        break
        for c, ws in dead:
            await self.disconnect(ws, c)
        return sent

    def channel_count(self) -> int:
        return len(self._clients)

    def total_clients(self) -> int:
        return sum(len(v) for v in self._clients.values())
