"""shared/ · main backend (app/) 와 Phase Lambda 가 함께 쓰는 모듈.

문서: RareLink_AI_Architecture_Concepts_v1.md §5.6

- db_models.py     · SQLAlchemy ORM (Aurora `soopulai` 스키마)
- schemas.py       · Pydantic 응답/요청 스키마 (frontend ↔ FastAPI 계약)
- db_session.py    · async DB 커넥션 풀
- phase_writers.py · 각 Phase 결과 INSERT 헬퍼 (Lambda 측에서도 import)
"""
