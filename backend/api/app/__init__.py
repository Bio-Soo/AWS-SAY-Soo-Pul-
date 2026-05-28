"""app/ · main backend FastAPI 앱.

구조 (RareLink_AI_Architecture_Concepts_v1 §5.6):
  - main.py     · FastAPI 앱 + 미들웨어 + lifespan
  - deps.py     · 공통 의존성 (get_db, get_current_clinician)
  - config.py   · 환경변수 → Settings
  - routers/    · sessions / patients / feedback / admin / emr_updates
  - services/   · stepfunctions / hapi_client / audit_log / poller_* / ws_*

실행:
    uvicorn api.app.main:app --reload --port 8000
    문서: http://localhost:8000/docs
"""
