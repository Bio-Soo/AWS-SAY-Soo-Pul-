# `api/` · Rare-Link AI Main Backend (FastAPI)

문서 기반: **RareLink_AI_Architecture_Concepts_v1.docx §5.6, §6**.

`lung_dx/` (Phase 1~5 모델 영역) 와 분리된 **메인 백엔드**.
프론트엔드가 호출하는 모든 데이터 endpoint 를 여기서 제공.

## 디렉토리 구조

```
api/
├── README.md                           ← 이 파일
├── requirements.txt                    ← 의존성 (httpx, jwt, sqlalchemy, ...)
├── app/                                · FastAPI 앱
│   ├── main.py                         · 앱 진입점, CORS, 라우터 등록
│   ├── deps.py                         · DI (get_db, get_current_clinician)
│   ├── config.py                       · 환경변수 → Settings
│   ├── routers/
│   │   ├── sessions.py                 · 진단 세션 (POST /sessions, /run · GET /{id} polling · /result · /rerun)
│   │   ├── patients.py                 · 환자 정보 (HAPI proxy + cache)
│   │   ├── feedback.py                 · 의사 피드백
│   │   ├── admin.py                    · 워크리스트, daily preload
│   │   └── emr_updates.py              · WebSocket 알림 (보충)
│   └── services/
│       ├── stepfunctions.py            · AWS Step Functions wrapper
│       ├── hapi_client.py              · HAPI FHIR REST 클라이언트
│       ├── audit_log.py                · HIPAA 감사 로그
│       ├── ws_connections.py           · WebSocket connection manager
│       ├── poller_mock.py              · 시연 mock event emitter
│       └── poller_fhir.py              · 실 FHIR ?_lastUpdated polling
└── shared/                             · main backend + Phase Lambda 공통
    ├── db_models.py                    · SQLAlchemy ORM (soopulai 스키마)
    ├── schemas.py                      · Pydantic 응답/요청
    ├── db_session.py                   · async 커넥션 풀
    └── phase_writers.py                · Phase 결과 INSERT 헬퍼
```

## 엔드포인트 일람 (문서 §5.6)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/v1/sessions` | 새 진단 세션 생성 |
| POST | `/api/v1/sessions/{id}/run` | Phase 1~5 파이프라인 시작 (Step Functions) |
| GET  | `/api/v1/sessions/{id}` | 세션 상태 + Phase 결과 (Frontend 가 2초 polling) |
| GET  | `/api/v1/sessions/{id}/result` | 최종 통합 리포트 |
| POST | `/api/v1/sessions/{id}/rerun` | 재진단 (새 세션 생성) |
| GET  | `/api/v1/patients/{fhir_id}` | 환자 detail (cache hit) |
| POST | `/api/v1/patients/import` | HAPI 에서 강제 fetch + cache 갱신 |
| POST | `/api/v1/feedback` | 의사 피드백 저장 |
| GET  | `/api/v1/worklist?date=YYYY-MM-DD` | 오늘 워크리스트 |
| POST | `/api/v1/admin/preload` | 수동 daily preload (manual rerun) |
| GET  | `/api/v1/emr-updates/health` | EMR poller 헬스 |
| WS   | `/ws/emr-updates?mrn=20-145982` | EMR 갱신 push (보충) |
| GET  | `/health` | 서비스 헬스 |

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `POLL_MODE` | `fhir` | EMR 폴링 모드 — `fhir` 또는 `mock` (시연) |
| `POLL_INTERVAL` | fhir=30, mock=8 (초) | 폴링 주기 |
| `FHIR_BASE_URL` | — | HAPI 또는 SMART sandbox URL |
| `FHIR_AUTH_TOKEN` | — | (선택) Bearer 토큰 |
| `MOCK_PATIENT_MRNS` | `20-145982,22-089433` | mock 모드 대상 MRN csv |
| `WS_PATH` | `/ws/emr-updates` | WebSocket 경로 |
| `JWT_PUBLIC_KEY_PATH` | — | SMART JWT 검증용 RS256 public key |
| `JWT_ALGORITHM` | `RS256` | |
| `JWT_AUDIENCE` | `rare-link-ai` | |
| `DEV_BYPASS_AUTH` | `0` | `1` 이면 인증 우회 (로컬 dev 전용) |
| `AWS_REGION` | `ap-northeast-2` | |
| `STEPFN_STATE_MACHINE_ARN` | — | Phase 1~5 Step Functions ARN |
| `DEV_STEPFN_DUMMY` | `0` | `1` 이면 Step Functions 호출 안 하고 가짜 ARN 반환 |
| `CXR_S3_BUCKET` | `say2-2team-bucket` | |
| `DATABASE_URL` | `sqlite+aiosqlite:///./soopulai_dev.db` | async DB URL |
| `CORS_ALLOWED_ORIGINS` | `localhost:5173,d300v14l8u0wx7.cloudfront.net` | |
| `LOG_LEVEL` | `INFO` | |

### 로컬 dev (mock everything)

```bash
DEV_BYPASS_AUTH=1 \
DEV_STEPFN_DUMMY=1 \
POLL_MODE=mock \
POLL_INTERVAL=5 \
uvicorn api.app.main:app --reload --port 8000
```

→ http://localhost:8000/docs (Swagger UI)
→ ws://localhost:8000/ws/emr-updates?mrn=20-145982

### 시연 (mock + 빠른 주기)

```bash
DEV_BYPASS_AUTH=1 \
POLL_MODE=mock \
POLL_INTERVAL=5 \
uvicorn api.app.main:app --port 8000
```

### 운영 (FHIR 실서버)

```bash
POLL_MODE=fhir \
FHIR_BASE_URL=https://hapi.example.com/fhir \
FHIR_AUTH_TOKEN=eyJh... \
JWT_PUBLIC_KEY_PATH=/etc/rare-link/smart-pubkey.pem \
DATABASE_URL=postgresql+asyncpg://user:pwd@aurora.../soopulai \
STEPFN_STATE_MACHINE_ARN=arn:aws:states:ap-northeast-2:...:stateMachine:Phase1to5 \
uvicorn api.app.main:app --host 0.0.0.0 --port 8000
```

## 클라이언트 호출 (Frontend)

```js
// 세션 생성
const r = await fetch('https://api.rare-link.kr/api/v1/sessions', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ patient_fhir_id: 'p-42', symptom_text: '기침 3주...' }),
});
const { session_id } = await r.json();

// 실행 시작
await fetch(`/api/v1/sessions/${session_id}/run`, { method: 'POST', ... });

// 2초마다 폴링
const poll = setInterval(async () => {
  const s = await fetch(`/api/v1/sessions/${session_id}`, ...).then(r => r.json());
  if (s.status === 'completed') { clearInterval(poll); /* 리포트 페이지로 이동 */ }
}, 2000);

// EMR 갱신 push (배지)
const ws = new WebSocket('wss://api.rare-link.kr/ws/emr-updates?mrn=20-145982');
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'emr-update') /* 배지 +N */ };
```

## 문서 대비 차이점 (참고)

| 영역 | 문서 §5.6 | 현재 구현 |
|---|---|---|
| 폴더 prefix | `rare-link-api/` (별도 repo) | `api/` (mono repo 안) |
| `pyproject.toml` | 권장 | 미작성 (root `requirements.txt` 사용) |
| `app/services/` 의 `bedrock_client.py` 등 | 문서 미상 | Phase 4/5 가 직접 호출 (Lambda 측) — main backend 는 stepfunctions.py 만 |
| WebSocket EMR updates | 문서 미언급 | EmrUpdateButton 배지 기능을 위해 추가 |

## 통합 (lung_dx/main.py 와의 관계)

`lung_dx/main.py` 는 Phase 파이프라인의 **단일 sync 호출** endpoint (`POST /api/v1/diagnose`).
이쪽 `api/app/main.py` 는 **async 진단 세션 + EMR proxy + 인증** 등을 갖는 **메인 백엔드**.
production 에선 두 앱을 별도 service 로 분리 배포 권장.

dev 단일 프로세스에서 두 라우터를 합치고 싶으면:
```python
# lung_dx/main.py 또는 새 통합 진입점
from lung_dx.api.router import router as lungdx_router
from api.app.main import app as backend_app
backend_app.include_router(lungdx_router)
```

## TODO (백엔드 팀 — 기태·태웅)

- [ ] `pyproject.toml` 정리 (root requirements 와 분리)
- [ ] alembic migration · `soopulai` 스키마
- [ ] `patients.py` 의 `_normalize_patient` — 프론트 `fhirAdapter.toUIShape()` 와 동일 매핑
- [ ] `stepfunctions.py` 의 ARN production 값 + IAM 권한
- [ ] `hapi_client.py` 의 service account JWT 또는 Smart Backend Services 인증
- [ ] HAPI rate limit / circuit breaker
- [ ] CloudWatch 통합 (현재는 stdout 로그만)
