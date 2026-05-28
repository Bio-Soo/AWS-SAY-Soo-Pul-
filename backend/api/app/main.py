"""FastAPI 앱 진입점 — Rare-Link AI main backend.

문서: §5.6 §6
실행:
    uvicorn api.app.main:app --reload --port 8000
    문서: http://localhost:8000/docs

CORS: Frontend (CloudFront / localhost:5173) 가 호출 가능하도록 origin 허용.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers.admin import router as admin_router
from .routers.emr_updates import setup_emr_updates
from .routers.feedback import router as feedback_router
from .routers.patients import router as patients_router
from .routers.sessions import router as sessions_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def _allowed_origins() -> list[str]:
    raw = os.getenv("CORS_ALLOWED_ORIGINS",
                    "http://localhost:5173,https://d300v14l8u0wx7.cloudfront.net")
    return [o.strip() for o in raw.split(",") if o.strip()]


app = FastAPI(
    title="Rare-Link AI · Main Backend",
    description=(
        "Rare-Link AI 의 main backend FastAPI.\n\n"
        "구조 문서: RareLink_AI_Architecture_Concepts_v1.docx §5.6.\n"
        "Phase 1~5 모델은 lung_dx/ 에 별도 — Step Functions 가 trigger."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# 라우터 등록 (모두 /api/v1 prefix)
app.include_router(sessions_router)
app.include_router(patients_router)
app.include_router(feedback_router)
app.include_router(admin_router)

# WebSocket EMR updates + 폴링 task lifespan
setup_emr_updates(app)


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "rare-link-ai-backend"}
