"""Rare-Link AI · Main Backend (FastAPI).

문서: RareLink_AI_Architecture_Concepts_v1.docx §5.6 (FastAPI 구조).

구조:
  api/
  ├── app/                    · FastAPI 앱 (main backend)
  │   ├── main.py             · 앱 진입점, 미들웨어, 라우터 등록
  │   ├── deps.py             · DI (get_db, get_current_clinician)
  │   ├── config.py           · Settings (env vars)
  │   ├── routers/            · 엔드포인트
  │   │   ├── sessions.py     · POST /sessions, /run · GET /{id} (polling) · /result · /rerun
  │   │   ├── patients.py     · GET /patients/{id} · POST /import (HAPI proxy + cache)
  │   │   ├── feedback.py     · POST /feedback
  │   │   ├── admin.py        · GET /worklist · POST /admin/preload
  │   │   └── emr_updates.py  · WebSocket /ws/emr-updates (보충)
  │   └── services/           · 외부 의존성 wrapper
  │       ├── stepfunctions.py · AWS Step Functions
  │       ├── hapi_client.py  · HAPI FHIR REST
  │       ├── audit_log.py    · 의료 감사 로그
  │       ├── ws_connections.py · WebSocket connection manager
  │       ├── poller_mock.py  · 시연용 mock 이벤트
  │       └── poller_fhir.py  · 실 FHIR ?_lastUpdated 폴링
  └── shared/                 · main backend ↔ Phase Lambda 공유
      ├── db_models.py        · SQLAlchemy ORM (soopulai 스키마)
      ├── schemas.py          · Pydantic (frontend ↔ FastAPI 계약)
      ├── db_session.py       · async DB 커넥션 풀
      └── phase_writers.py    · 각 Phase 결과 INSERT 헬퍼

실행:
    uvicorn api.app.main:app --reload --port 8000
    문서: http://localhost:8000/docs
"""
