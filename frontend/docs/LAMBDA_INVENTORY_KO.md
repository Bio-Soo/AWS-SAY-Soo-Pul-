# Lambda 인벤토리 · 시스템 연결 계획 (v3)

**작성일**: 2026-05-11 (W4)
**변경 이력**:
- v1 — 4-phase orchestrator + 폴링 모델 초안
- v2 — phase별 progressive emit (DDB), 6 phase, P1‖P2 / P4‖P5 병렬
- **v3 — (1) 재시도 3-버튼 (전체/이미지/희귀) (2) EMR DocumentReference 변경 감지 (3) Dual-deployment 아키텍처(cloud serverless ↔ on-prem)**

---

## 0. v2 → v3 changelog

| 영역 | 변경 |
|---|---|
| 재시도 UX | (없음) → **A4 rerun-all · A5 rerun-image · A6 rerun-rare** 3개 Lambda 추가. SFN에 `start_from` 입력 추가 |
| EMR 변경 감지 | (없음) → 프론트 60s polling 또는 **A7 emr-note-watcher** Lambda 옵션 추가. DocumentReference 새 버전 감지 시 재분석 유도 |
| 배포 모델 | 클라우드 단일 → **Dual-deployment**: cloud(serverless) ↔ on-prem(self-hosted) 동일 코드 |
| AI 추상화 | 명시 안 됨 → `lung_dx/ai/interfaces.py` 도입. EmbeddingClient·LLMClient·VectorStore 인터페이스 |
| RAG 벡터 저장소 | OpenSearch vs pgvector 보류 → **Aurora pgvector 확정** (MVP) |
| DDB 스키마 | 단일 attempt | `attempt` 카운터 + `history[]` 추가 (재시도 audit) |

---

## 1. Phase 정의 (v2와 동일)

| # | 이름 | 입력 | 출력 | DDB emit | FHIR | Latency |
|---|---|---|---|---|---|---|
| **1** | HPO 추출 | 임상노트 텍스트 | positive/negative HPO | ✅ | `Observation`×N | 2~5s |
| **2** | CXR DenseNet | X-ray PNG | 14 label + Grad-CAM | ✅ | `DiagnosticReport` + `Observation`×14 | 1~3s |
| **3** | 528 일반질환 스코어링 | 1+2+Lab+VRH+Micro | top-N (label=draft) | ✅ | `RiskAssessment` | <1s |
| **4** | LLM 검증 | 3 + 환자 컨텍스트 | revised ranking | ✅ | `ClinicalImpression` | 20~60s |
| **5** | 376 희귀질환 listing | 1·2·3 raw + 자체 가중치 | rare candidates | ✅ | `RiskAssessment` (label=rare) | <2s |
| **F** | RAG 최종 리포트 | 4 + 5 + 유사 케이스 | 임상소견서 md | ✅ | `DocumentReference` + S3 md | 30~60s |

---

## 2. SFN 그래프 — `start_from` 분기 추가 (v3)

```
                       start
                         │
                         ▼
              ┌──────────────────────┐
              │ ChoiceStartingPhase  │  ← input.start_from 으로 분기
              └──────────┬───────────┘
                         │
       ┌─────────────────┼─────────────────────────────────┐
       │ all (기본)       │ image                          │ rare
       ▼                  ▼                                 ▼
  ┌───────────┐    ┌────────────────────┐           ┌──────────────┐
  │P1 ‖ P2    │    │ Reuse P1 from DDB  │           │ Reuse P1~4   │
  │둘 다 다시 │    │ → run P2 only      │           │ → run P5 only│
  └─────┬─────┘    └─────────┬──────────┘           └──────┬───────┘
        │                    │                              │
        ▼                    ▼                              │
  ┌──────────┐         ┌──────────┐                        │
  │P3 scoring│         │P3 scoring│                        │
  └─────┬────┘         └────┬─────┘                        │
        │                   │                              │
        ▼                   ▼                              │
  ┌─────────────┐     ┌─────────────┐                     │
  │ P4 ‖ P5     │     │ P4 ‖ P5     │                     │
  └──────┬──────┘     └──────┬──────┘                     │
         │                   │                            │
         └─────────┬─────────┴────────────────────────────┘
                   ▼
            ┌──────────────┐
            │ B6 final-RAG │
            └──────┬───────┘
                   ▼
                  DONE
```

`start_from="all"` (전체 재분석) → P1·P2부터 다시. `"image"` → P1 결과는 DDB에서 재사용, P2만 새로. `"rare"` → P1~P4 결과 재사용, P5만 다시 → final 다시.

> **공통**: final RAG는 **항상 마지막에 다시 실행**. 어느 phase가 갱신되든 최종 리포트가 그 변화를 반영해야 하므로.

---

## 3. A 그룹 — 프론트가 직접 부르는 Lambda

| ID | 메서드 | 경로 | 역할 |
|---|---|---|---|
| **A1** | POST | `/api/diagnose` | 신규 진단 시작 (새 execution_id) |
| **A2** | GET | `/api/diagnose/{id}/state` | 진행 상태 + 누적 결과 polling (2s) |
| **A3** | POST | `/api/upload/cxr` | CXR S3 presigned upload URL |
| **A4** | POST | `/api/diagnose/{id}/rerun/all` | 전체 재분석 (모든 phase) |
| **A5** | POST | `/api/diagnose/{id}/rerun/image` | 이미지만 (P2부터 cascade) |
| **A6** | POST | `/api/diagnose/{id}/rerun/rare` | 희귀질환만 (P5 + final) |
| **A7** | (선택) GET | `/api/emr/note/{patient_id}/latest-version` | EMR 임상노트 최신 버전 확인 |

### A1·A2·A3 (v2와 동일)

생략 — v2 §3 참고.

### A4. `lambda-rerun-all`

| 항목 | 값 |
|---|---|
| Trigger | `POST /api/diagnose/{id}/rerun/all` |
| 입력 | `{ note?: string, cxr_s3_key?: string }` (옵션 — 없으면 이전 값 재사용) |
| 처리 | (1) DDB row의 phase1~final을 `status: "running"`으로 reset, `attempt += 1`<br>(2) SFN execution 시작, input `{ execution_id, start_from: "all", attempt: N }` |
| 출력 | `{ execution_id, attempt }` |
| 프론트 UI | **환자 정보 창** (Sticky 환자 배너 우측) "전체 재분석" 버튼 |
| 사용 시나리오 | 환자 상태 변화 / 이전 결과 신뢰 불가 / 의사 판단으로 처음부터 |
| 비고 | 이전 attempt 결과는 DDB `history[]`로 보존. UI에서 "Attempt 1 vs 2" 비교 가능 (W5 사치 옵션) |

### A5. `lambda-rerun-image`

| 항목 | 값 |
|---|---|
| Trigger | `POST /api/diagnose/{id}/rerun/image` |
| 입력 | `{ cxr_s3_key: string }` (새로 업로드한 이미지의 S3 key 필수) |
| 처리 | (1) DDB의 phase2~final reset (phase1·HPO는 유지)<br>(2) SFN 시작, input `{ execution_id, start_from: "image", cxr_s3_key, attempt: N }` |
| 출력 | `{ execution_id, attempt }` |
| 프론트 UI | **이미지 보여주는 창** (Heatmap 패널) 우상단 "이미지 재분석" 버튼 → 파일 선택 다이얼로그 → A3 presign 받아 PUT → A5 호출 |
| 사용 시나리오 | X-ray 재촬영본 업로드, 다른 view (lateral) 추가, GradCAM 다시 |

### A6. `lambda-rerun-rare`

| 항목 | 값 |
|---|---|
| Trigger | `POST /api/diagnose/{id}/rerun/rare` |
| 입력 | `{}` 또는 `{ extra_hpo_codes?: string[] }` (의사가 수동 추가한 HPO) |
| 처리 | (1) DDB의 phase5·final reset<br>(2) extra_hpo가 있으면 phase1 result에 merge<br>(3) SFN 시작, input `{ execution_id, start_from: "rare", attempt: N }` |
| 출력 | `{ execution_id, attempt }` |
| 프론트 UI | **희귀질환 유의 창 상단** "희귀질환 재시도" 버튼 (옵션 + HPO 추가 입력 칸) |
| 사용 시나리오 | phase5 실패 / 의사가 추가 임상 단서 발견 / 자체 가중치 튜닝 검증 |

### A7. `lambda-emr-note-watcher` (선택)

| 항목 | 값 |
|---|---|
| Trigger | `GET /api/emr/note/{patient_id}/latest-version` |
| 역할 | EMR FHIR 서버에서 해당 환자의 DocumentReference 중 가장 최근 `meta.versionId` 또는 `meta.lastUpdated` 조회만 |
| 출력 | `{ version_id, last_updated, content_hash }` |
| 비고 | **프론트에서 fhirclient로 직접 조회해도 됨**. Lambda 두는 이유는 (a) 토큰을 백엔드에 숨김 (b) CORS 우회 (c) 캐시. MVP는 프론트 직접 우선. |

---

## 4. EMR DocumentReference 변경 감지 정책

### 4-1. 흐름

```
워크스페이스 화면 mount
  │
  ▼
60s 간격 setInterval 시작
  │
  ▼
fhir.request(`DocumentReference?patient=${id}&_count=1&_sort=-date`)
  │
  ▼
응답의 entry[0].resource.meta.lastUpdated 또는 versionId 비교
  │
  ├─ 변경 없음 → 다음 tick
  │
  └─ 변경 감지
        │
        ▼
   주호소 박스 상단에 노란 띠:
   "임상노트가 업데이트됐습니다 (08:42 갱신). 새 내용 보기 / 재분석 / 무시"
        │
        ├─ 새 내용 보기 → 노트 박스 내용만 갱신 (분석 보존)
        ├─ 재분석     → A4 rerun-all 호출
        └─ 무시       → 이번 버전 ID를 ignored set에 추가 (다음 tick까지 띠 숨김)
```

### 4-2. 왜 자동 재분석 안 하는가

- LLM/SageMaker 비용. 의사 명시적 확인 후 호출
- 임상노트 자잘한 수정(오타 정정)에도 재분석되면 noisy
- HITL 원칙 (EU AI Act Art. 22) — 자동화 판단 위임 금지

### 4-3. SMART on FHIR Subscription 안 쓰는 이유

- FHIR R4 `Subscription` REST hook은 EMR마다 지원 천차만별 (Epic 한정, Cerner 일부)
- 데모용 SMART Sandbox는 미지원
- 60s polling이 단순 + 발표 데모로 충분

---

## 5. B 그룹 — Step Functions 안 (v2와 동일)

```
B1 phase1-hpo-extract         Bedrock Haiku(클라우드) | vLLM(온프레)
B2 phase2-cxr-densenet        SageMaker(클라우드) | chexnet_local(온프레)
B3 phase3-scoring             528 disease YAML (어디서나 동일)
B4 phase4-llm-verify          Bedrock Sonnet(클라우드) | vLLM(온프레)
B5 phase5-rare-listing        376 rare YAML (어디서나 동일)
B6 final-rag-report           Bedrock Titan+Sonnet(클라우드) | TEI+vLLM(온프레)
```

각 phase 끝에 `emit_result()` 공통 헬퍼 호출 (§7).

### B1~B6 모두에 추가된 입력 처리

```python
def handler(event, context):
    exec_id    = event["execution_id"]
    start_from = event.get("start_from", "all")
    attempt    = event.get("attempt", 1)

    # 이 phase가 start_from에 의해 skip 대상인지 판단
    if should_skip(phase_name=__phase__, start_from=start_from):
        prev = ddb.get_item(exec_id, __phase__)
        return {**prev["result"], "_reused_from_attempt": prev["attempt"]}

    # 정상 처리
    ...
```

`should_skip` 매트릭스:

| phase | start_from=all | =image | =rare |
|---|---|---|---|
| P1 HPO | 실행 | **skip (reuse)** | **skip** |
| P2 CXR | 실행 | 실행 | **skip** |
| P3 scoring | 실행 | 실행 | **skip** |
| P4 verify | 실행 | 실행 | **skip** |
| P5 rare | 실행 | 실행 | 실행 |
| Final RAG | 실행 | 실행 | 실행 |

---

## 6. DynamoDB 스키마 v3 (재시도 audit 추가)

```
Table: rare-link-diagnose-results
─────────────────────────────────
PK (HASH):  execution_id
SK (RANGE): phase  ("meta" | "phase1" | ... | "final_report" | "history#<n>")

기본 attributes:
  status, result, error, fhir_refs, started_at, completed_at, duration_ms
  attempt:   Number   ← v3 신규 (현재 진행 중인 attempt 번호)

meta row 전용:
  case_id:   String
  current_attempt: Number
  total_attempts:  Number

history#1, history#2, ... row:
  ─ 이전 attempt 결과의 snapshot
  ─ rerun 호출될 때마다 현재 phase rows를 history#<N>로 복사 후 reset
  ─ TTL 24h (현재 attempt보다 짧게)
```

A2 응답은 항상 **current attempt만** 반환. UI에서 "이전 attempt 보기" 토글이 있으면 `?attempt=1` 쿼리로 history row 조회.

---

## 7. 공통 헬퍼 — Lambda Layer 모듈

```python
# rare_link_common.emit
def emit_result(execution_id, phase, result=None, error=None, attempt=None):
    """
    1) DDB PutItem  (PK=execution_id, SK=phase, attribute attempt)
    2) HAPI POST    — phase별 FHIR 리소스
    3) (선택) WebSocket
    """

# rare_link_common.rerun
def archive_to_history(execution_id, phases_to_reset, new_attempt):
    """rerun 시작 시 호출. 현재 phase rows를 history#<n-1>로 copy 후 reset."""
```

---

## 8. C 그룹 — 배치 (v2와 동일)

- **C1 lambda-mimic-etl** — P0 (HAPI 적재)
- **C2 lambda-loinc-map-loader** — P0 (LOINC 매핑)
- **C3 lambda-cleanup-uploads** — 발표 후
- **C4 lambda-embed-cohort** ← v3 신규. 적재된 100명 코호트를 한 번에 임베딩 → Aurora pgvector 테이블에 저장. C1 직후 1회 실행.

---

## 9. Dual-Deployment 아키텍처

### 9-1. 클라우드(serverless) 기본 매핑

| 컴포넌트 | AWS 서비스 |
|---|---|
| compute | Lambda (모든 A·B Lambda) |
| orchestration | Step Functions |
| state cache | DynamoDB on-demand |
| 환자 FHIR DB | Aurora PostgreSQL (HAPI 백엔드) |
| **임베딩 모델** | **Bedrock Titan Embeddings v2** |
| **벡터 스토어** | **Aurora pgvector** (CREATE EXTENSION 1줄, $0 incremental) |
| LLM 추론 | Bedrock Claude Haiku (Phase 1) + Sonnet 4.6 (Phase 4·F) |
| CXR 추론 | SageMaker Endpoint (DenseNet) |
| 파일 저장 | S3 `say2-2team-bucket` |
| API | API Gateway HTTP API |

### 9-2. 온프레미스 대체 매핑

| 컴포넌트 | 온프레 대체 |
|---|---|
| compute | ECS Task / Kubernetes Pod / docker-compose 서비스 |
| orchestration | Argo Workflows / Temporal / 단순 Python orchestrator |
| state cache | PostgreSQL 또는 Redis |
| 환자 FHIR DB | 자체 PostgreSQL + HAPI |
| **임베딩 모델** | **HuggingFace TEI 컨테이너 + bge-m3 또는 nomic-embed** |
| **벡터 스토어** | 자체 PostgreSQL + pgvector (스키마 동일) |
| LLM 추론 | vLLM + Qwen2.5-7B/14B (HPO 추출), Llama-3.1-70B 또는 Solar (검증·생성) |
| CXR 추론 | `lung_dx/phase1_xray/chexnet_local.py` (이미 구현돼 있음) |
| 파일 저장 | MinIO 또는 NAS |
| API | nginx + 자체 인증 |

### 9-3. AI 인터페이스 추상화 (코드 골격)

```python
# lung_dx/ai/interfaces.py  (신규)
from typing import Protocol

class EmbeddingClient(Protocol):
    def embed(self, text: str) -> list[float]: ...
    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...

class LLMClient(Protocol):
    def complete(self, system: str, messages: list[dict], **kw) -> str: ...

class VectorStore(Protocol):
    def upsert(self, doc_id: str, vector: list[float], metadata: dict) -> None: ...
    def query(self, vector: list[float], k: int, filter: dict | None = None) -> list[dict]: ...

# lung_dx/ai/cloud_bedrock.py  (클라우드 구현체)
class BedrockEmbeddingClient: ...
class BedrockLLMClient:        ...

# lung_dx/ai/onprem_local.py   (온프레 구현체 — W6+)
class TEIEmbeddingClient: ...   # HTTP to TEI container
class VLLMClient:        ...   # HTTP to vLLM container

# lung_dx/ai/stores.py          (어디서나 동일 — PostgreSQL pgvector)
class PgvectorStore: ...

# 선택 로직 (환경변수 1개)
def get_clients() -> tuple[EmbeddingClient, LLMClient, VectorStore]:
    mode = os.getenv("DEPLOYMENT_MODE", "cloud")
    if mode == "cloud":
        return BedrockEmbeddingClient(), BedrockLLMClient(), PgvectorStore(aurora_dsn)
    else:
        return TEIEmbeddingClient(TEI_URL), VLLMClient(VLLM_URL), PgvectorStore(local_dsn)
```

### 9-4. 발표 자료 한 줄

> "Rare-Link AI는 **AI 호출 레이어 추상화**(`EmbeddingClient`·`LLMClient`·`VectorStore` 인터페이스)를 통해 클라우드 배포(AWS Bedrock + Aurora pgvector + SageMaker)와 온프레미스 배포(self-hosted vLLM + TEI + PostgreSQL pgvector)를 동일 코드베이스로 지원합니다. 빅5급 보안 정책 병원도 환자 데이터를 외부로 송출하지 않고 동일한 진단 품질을 받을 수 있습니다."

### 9-5. W3~W5에 무엇을 만들고 무엇을 미루나

| 시점 | 작업 |
|---|---|
| W3~W4 | **클라우드 구현만 완성**. 단 `ai/interfaces.py` + `cloud_bedrock.py` 분리해서 작성 |
| W5 | 발표 자료에 dual-deployment 다이어그램·논리 포함. 코드는 클라우드만 |
| **발표 후** (W6+) | `onprem_local.py` 어댑터 추가. docker-compose.onprem.yml 작성. 빅5 데모 가능 상태로 |
| 실 도입 (M3+) | 병원별 GPU 사양 평가 → 모델 선택 → SLA · 감사 로그 설계 |

---

## 10. 기존 코드 → v3 Lambda 매핑

| 현재 위치 | v3 Lambda | 메모 |
|---|---|---|
| `lung_dx/api/router.py` `POST /diagnose` | A1 | 입력 검증 + SFN 시작 |
| `lung_dx/pipeline/diagnostic_pipeline.py` | SFN ASL | 코드 옮김 안 함 |
| `lung_dx/phase1_xray/finding_extractor.py` (HPO 부분) | B1 | Bedrock Haiku로 교체 |
| `lung_dx/phase1_xray/sagemaker_client.py` + `chexnet_local.py` | B2 | 둘 다 보존 (cloud/onprem) |
| `lung_dx/phase2_multimodal/*` | B3 | 거의 그대로 |
| `lung_dx/phase4_report/bedrock_client.py` | B4 (검증) + B6 (생성) | 둘로 분기 |
| `lung_dx/phase3_rare/*` | B5 | 그대로, 번호만 P5로 |
| (신규) | **`lung_dx/ai/interfaces.py`** | v3 핵심 추가 |
| (신규) | **`lung_dx/ai/cloud_bedrock.py`** | Bedrock 어댑터 |
| (신규, W6+) | **`lung_dx/ai/onprem_local.py`** | 온프레 어댑터 |

---

## 11. 우선순위 (발표 5/28 역산)

| Tier | 항목 |
|---|---|
| **P0 (W3)** | C1·C2 ETL · A3 presign · A1·A2 + DDB · B1·B2 · `ai/interfaces.py` + `cloud_bedrock.py` |
| **P0** | B3 scoring · 프론트 progressive 카드 |
| **P1 (W4)** | B4 verify · B5 rare · A4·A5·A6 재시도 3-버튼 |
| **P1** | EMR DocumentReference polling (프론트 코드, Lambda 옵션) |
| **P2 (W4 후반)** | C4 embed-cohort · B6 final-RAG |
| **P3 (W5)** | 에러 핸들러 · attempt 비교 UI · 발표 자료 dual-deployment 다이어그램 |
| **발표 후** | `onprem_local.py` · WebSocket · EMR vendor registry · Cognito |

---

## 12. Action Items

박성수(Frontend):
- [ ] `src/api/diagnoseApi.js` — `submitDiagnose`, `pollState`, `rerunAll`, `rerunImage`, `rerunRare`
- [ ] `src/api/uploadApi.js` — `requestUploadUrl`
- [ ] `src/api/emrSyncApi.js` (또는 fhirAdapter 확장) — `pollLatestNoteVersion(patientId)`
- [ ] 3-버튼 UI 배치: (a) 환자 배너 우측 "전체 재분석" (b) Heatmap 패널 우상단 "이미지 재분석" (c) 희귀질환 카드 상단 "희귀 재시도"
- [ ] 임상노트 변경 알림 띠 (주호소 박스 상단)
- [ ] IAM Tier 3 권한 요청

배기태·허태웅(인프라):
- [ ] DDB 테이블 + `attempt`/`history#` 스키마
- [ ] API Gateway HTTP API (A1~A6, 옵션 A7)
- [ ] SFN `rare-link-diagnose-sfn` — `ChoiceStartingPhase` + 병렬 분기 2곳
- [ ] B1~B6 Lambda + Layer 3개 (`common`, `torch`, `kb`)
- [ ] SageMaker endpoint 배포
- [ ] Aurora pgvector 확장 활성화 + `embeddings` 테이블 스키마
- [ ] Bedrock 모델 접근 권한 확인 (Titan v2, Haiku, Sonnet 4.6)

권미라·양희인(데이터):
- [ ] C1 MIMIC 100명 코호트 → HAPI POST
- [ ] C2 LOINC 매핑표
- [ ] C4 코호트 임베딩 배치 (C1 직후 1회)

박성수 + 백엔드 공동:
- [ ] `lung_dx/ai/interfaces.py` 합의 (메서드 시그니처)
- [ ] `cloud_bedrock.py` 구현
- [ ] `lung_dx/ai/onprem_local.py` skeleton만 (발표 자료용)

---

## 13. 한눈 요약

```
프론트 호출 (A · API Gateway):
  A1  diagnose-start         POST   /api/diagnose
  A2  diagnose-state         GET    /api/diagnose/{id}/state          ← polling 2s
  A3  presign-upload         POST   /api/upload/cxr
  A4  rerun-all              POST   /api/diagnose/{id}/rerun/all      ★ 환자 배너
  A5  rerun-image            POST   /api/diagnose/{id}/rerun/image    ★ Heatmap 패널
  A6  rerun-rare             POST   /api/diagnose/{id}/rerun/rare     ★ 희귀질환 카드
  A7  emr-note-watcher (opt) GET    /api/emr/note/{pid}/latest-version

내부 phase (B · SFN, ChoiceStartingPhase로 부분 실행 가능):
  ┌─ B1 phase1-hpo ─┐
  │                 ├── B3 phase3-scoring ─┬─ B4 phase4-llm-verify ─┐
  └─ B2 phase2-cxr ─┘                      └─ B5 phase5-rare ────────┴── B6 final-rag

공용 (Lambda Layer):
  emit_result(exec_id, phase, result|error, attempt)
  archive_to_history(exec_id, phases, new_attempt)

배치 (C):
  C1 mimic-etl   C2 loinc-map   C3 cleanup   C4 embed-cohort

배포 모드 (DEPLOYMENT_MODE 환경변수):
  cloud  → Bedrock + Aurora pgvector + SageMaker
  onprem → vLLM + TEI + PostgreSQL pgvector + chexnet_local
  → ai/interfaces.py 가 swap 지점
```

흐름: EMR launch → 환자 클릭 → A1 → SFN(병렬 6 phase) → A2 폴링 → 카드 progressive 렌더 → 의사가 필요 시 A4·A5·A6로 부분 재실행 → EMR 노트 변경 시 알림.
