# Rare-Link AI · 프론트엔드 & 관련 백엔드 가이드

**대상 독자**: 웹/클라우드 사전 지식이 거의 없는 팀원 (보호자·교수·다른 트랙 동료에게 보여줘도 이해될 수준)
**작성 시점**: 2026-05-11 (W4 진입)
**작성자**: Frontend Lead 박성수 + Claude Code 정리
**문서 위치**: `frontend/docs/ARCHITECTURE_GUIDE_KO.md`

이 문서는 우리 프로젝트의 **프론트엔드**(사용자가 보는 화면)와 **그 프론트엔드를 동작시키기 위한 백엔드 부품들**(서버·AI 모델·환자 데이터 저장소·인증)이 어떻게 연결돼 있는지, 그리고 그 안에서 EMR/FHIR 같은 의료 도메인 용어가 어떤 역할을 하는지를 설명합니다.

---

## 0. TL;DR (한 줄 요약)

> 의사가 브라우저에서 React 앱을 열면, 그 앱이 **AWS EC2 위에서 도는 FHIR 서버**에서 환자 데이터를 받아오고, **AWS SageMaker**에 흉부 X-ray를 보내 AI 판독을 받고, **AWS Lambda + Aurora DB**에서 진단 순위를 만들어 다시 화면에 그려준다. 사용하는 AWS 자원은 S3 버킷 `say2-2team-bucket`과 EC2 인스턴스 `i-0f3f223fd40217b12 (2-2team-fhir-ec2)`.

---

## 1. 그림으로 보는 전체 구조

```
   [ 의사의 브라우저 ]
          │
          │  ① 사이트 접속 (HTTP)
          ▼
   ┌──────────────────────────────────────────────┐
   │  EC2 i-0f3f223fd40217b12 (2-2team-fhir-ec2)   │
   │  Public IP 15.164.21.221                     │
   │                                              │
   │  ─ Port 80   nginx       정적 React 빌드 서빙 │
   │  ─ Port 8080 HAPI FHIR   환자 데이터 REST API │
   │  ─ Port 22   SSH         관리자 접속용        │
   └──────────────────────────────────────────────┘
          │                          │
          │ ② 환자 목록·검사결과     │ ③ JPA(SQL)
          │   (FHIR REST)            ▼
          │                  ┌──────────────────────┐
          │                  │ Aurora PostgreSQL    │
          │                  │ rarelink / hapi 스키마│
          │                  │ (환자·검사·소견 등)   │
          │                  └──────────────────────┘
          ▼
   ┌─────────────────────────┐
   │ React 앱 (사용자 화면)   │
   │ - 로그인 → 환자 목록     │
   │ - 진단 워크스페이스       │
   │ - LR 막대·Heatmap 등     │
   └─────────────────────────┘
          │
          │ ④ X-ray 추론
          ▼
   ┌─────────────────────────┐
   │ AWS SageMaker Endpoint  │
   │ (DenseNet-121, "SooNet")│
   │  → 14개 CXR 레이블 확률   │
   └─────────────────────────┘
          │
          │ ⑤ HPO·Lab·CXR 결과 종합 → 528개 폐질환 랭킹
          ▼
   ┌─────────────────────────┐
   │ AWS Lambda (Phase 3·4)  │
   │  + 528 질환 YAML        │
   │  + 정상범위 YAML        │
   │  + Bedrock Claude Haiku/│
   │    Sonnet (요약·검증)   │
   └─────────────────────────┘
          │
          │ ⑥ 모델 가중치·이미지·소견서 저장
          ▼
   ┌─────────────────────────┐
   │ S3 버킷 say2-2team-bucket│
   │  - models/chexnet/      │
   │  - cxr_images/          │
   │  - reports/             │
   │  - Phase_3, Phase_4/ 등 │
   └─────────────────────────┘
```

번호는 데이터 흐름. 이 7개 박스만 머리에 들어오면 그 다음은 다 디테일입니다.

---

## 2. 용어 사전 (먼저 알고 가야 할 것들)

| 용어 | 설명 | 우리 프로젝트에서 |
|---|---|---|
| **프론트엔드 (Frontend)** | 사용자가 직접 보는 화면. 브라우저에서 도는 코드. | React 앱. 의사가 환자를 클릭하고 X-ray를 보는 그 화면. |
| **백엔드 (Backend)** | 사용자가 직접 보지 않는 서버 쪽 로직. 데이터를 저장·계산·반환. | HAPI FHIR 서버, Lambda 함수, SageMaker. |
| **React** | 화면을 "컴포넌트" 단위로 조립하는 JavaScript 라이브러리. | `LoginWorklist.jsx`, `DesignSystem.jsx` 등. |
| **Vite** | React 코드를 브라우저가 이해할 수 있게 변환·번들링하는 **개발 도구**. `npm run dev` 시 5173 포트로 띄움. | `frontend/vite.config.js`. |
| **Tailwind CSS** | `class="bg-blue-500 p-4"` 식으로 디자인을 inline 클래스로 적용. CSS 파일을 거의 안 씀. | `frontend/tailwind.config.js` + `src/index.css`. |
| **HTTP / REST API** | 브라우저가 서버에게 "환자 100명 줘" 같이 요청 보내는 표준 방식. URL + 메서드(GET/POST 등). | FHIR 서버에 `GET /Patient?_count=20` 호출. |
| **JSON** | 데이터를 텍스트로 표현하는 형식. `{"name": "kim", "age": 60}` 같은 모양. | FHIR 응답도 전부 JSON. |
| **EC2** | AWS의 "가상 컴퓨터 한 대 빌리기" 서비스. 우리는 이걸로 nginx + FHIR 서버를 띄움. | `i-0f3f223fd40217b12`, t3.large, 서울 리전. |
| **S3** | AWS의 "무한 용량 파일 보관함". 폴더처럼 보이지만 사실은 key→file 매핑. | `say2-2team-bucket`. 이미지·모델·소견서 다 여기. |
| **Lambda** | AWS의 "함수 한 번 실행하기" 서비스. 서버를 직접 띄울 필요 없이 코드 조각만 올림. | Phase 3 스코어링, Phase 4 LLM 검증. |
| **SageMaker** | AWS의 "AI 모델 호스팅" 서비스. 모델 가중치 업로드하면 HTTPS endpoint로 추론 가능. | DenseNet-121 (SooNet) CXR 분류기. |
| **Aurora** | AWS가 만든 PostgreSQL 호환 클라우드 DB. 일반 RDS보다 빠르고 안정적. | 환자/검사/소견서 데이터의 진짜 저장소. |
| **Cognito** | AWS의 "사용자 로그인" 서비스. 회원가입·비밀번호·MFA·소셜로그인 다 해줌. | 현재는 mock(가짜), 발표 후 실 Cognito로 교체 예정. |
| **EMR** | Electronic Medical Record. 병원이 쓰는 전자의무기록 시스템. | Epic·Cerner·BESTCare 2.0 등이 대표적. 우리는 그 안에 "앱"으로 끼워넣는 그림. |
| **FHIR** | Fast Healthcare Interoperability Resources. **의료 데이터 교환 표준**. Patient·Observation 같은 정형 리소스. | HAPI FHIR(EC2)가 우리 FHIR 서버. |
| **SMART on FHIR** | EMR이 외부 앱(우리 같은)에게 환자 데이터 접근 권한을 안전하게 위임하는 OAuth2 기반 표준. | 의사가 EMR에서 "Rare-Link AI 실행" 클릭 → 우리 앱이 환자 데이터 받아옴. |
| **OAuth2** | "이 앱이 내 데이터에 접근해도 됨" 동의를 토큰으로 처리하는 인증/인가 표준. | SMART on FHIR이 OAuth2 위에 만들어진 의료 특화 규약. |
| **HPO** | Human Phenotype Ontology. 사람 증상을 표준 코드로 표현한 사전. | `HP:0012735` = 기침. Phase 1·3에서 사용. |
| **LOINC** | 검사 항목 표준 코드. | `2532-0` = LDH. Lab 결과 매핑에 사용. |
| **DICOM / PACS** | 의료영상 표준 포맷·저장 시스템. | 우리는 일단 PNG 변환본 사용, DICOM은 미래 작업. |
| **LR (Likelihood Ratio)** | "이 증상이 있을 때 이 질환일 확률"을 측정하는 통계량. | Robinson 2020 논문 기반. UI에 막대그래프로. |

---

## 3. 프론트엔드 자세히 보기

### 3-1. 어디서 어떻게 도는가

- **개발할 때**: 박성수 PC에서 `npm run dev` → 브라우저 `http://localhost:5173`에서 즉시 변경 반영(HMR).
- **빌드한 결과물**: `npm run build` → `frontend/dist/` 폴더에 `index.html`, `assets/main-XXXXX.js` 같은 **정적 파일**들이 만들어짐.
- **실제 의사가 접속하는 라이브 사이트**: 그 dist 폴더를 **EC2 (`i-0f3f223fd40217b12`)** 의 nginx가 서빙. 현재 `http://15.164.21.221/Frontend/` 경로로 떠 있음. (현재 라이브에는 4일 전 빌드가 떠 있음 — `main-CHWXTtVT.js`)

### 3-2. 핵심 파일 지도

```
frontend/
├── index.html                  ← 브라우저가 처음 받는 HTML. <script>로 main.jsx 로드
├── src/
│   ├── main.jsx                ← React 앱 시작 지점
│   ├── App.jsx                 ← 로그인 화면 / 디자인 시스템 토글
│   ├── LoginWorklist.jsx       ← 화면 ①② (로그인 + 환자 목록 + 프리뷰)
│   ├── DesignSystem.jsx        ← 컬러/폰트/컴포넌트 카탈로그 (발표 자료용)
│   ├── index.css               ← Tailwind 지시문 + 기본 폰트
│   ├── api/
│   │   └── fhirAdapter.js      ★ FHIR R4 JSON → UI에 쓰기 쉬운 모양 변환
│   ├── auth/
│   │   ├── session.js          ← 의사 로그인 세션 (sessionStorage, 1h TTL)
│   │   ├── smartLauncher.js    ← SMART on FHIR OAuth 발동 헬퍼
│   │   └── seedDoctors.js      ← 데모용 의사 5명 시드
│   └── config/
│       └── emrVendors.js       ← Epic/Cerner/SMART Sandbox 엔드포인트 목록
├── launch.html                 ← EMR이 우리 앱을 띄울 때 진입 (SMART launch)
├── app.html                    ← OAuth 콜백 (토큰 수신)
└── package.json                ← 의존성 + npm 스크립트
```

`api/fhirAdapter.js`가 **프론트–백엔드 계약의 핵심**입니다. FHIR 응답(`Patient`, `Observation` 등)이 들어오면 `toUIShape()` 함수가 화면이 바로 쓰는 모양(`{ mrn, name, age, sex, complaint, ... }`)으로 변환합니다. mock 데이터든 진짜 FHIR이든 이 함수만 통과하면 화면 코드는 똑같이 동작합니다.

### 3-3. Mock 모드 vs Real 모드

`.env`에 `VITE_USE_MOCK=true`면 **가짜 환자 데이터**(`MOCK_PATIENTS` 배열)로 동작. `false`면 진짜 FHIR 서버에 붙어 OAuth2 흐름 발동. 이 분기 하나로 박성수(프론트)와 인프라팀이 **병렬 개발** 가능.

### 3-4. 디자인 토큰

색깔은 모두 CSS 변수로:

- `--rl-primary` `#0C447C` — 브랜드 파랑
- `--rl-teal` `#0E8574` — LR 지지(녹색)
- `--rl-critical` `#A32D2D` — LR 반박(빨강)
- `--rl-amber` `#B45309` — Don't miss 주의
- `--rl-rare` `#6B21A8` — 희귀질환 배지

폰트는 IBM Plex Sans KR / Mono. AI slop 보라색 그라데이션 금지(CLAUDE.md §3).

---

## 4. "프론트 관련 백엔드" 자세히 보기

프론트가 직접 데이터를 만들지 않고 **부탁하는 대상**들입니다. 각각이 어디서 돌고 어떤 역할을 하는지.

### 4-1. HAPI FHIR Server (EC2 :8080) — 환자 데이터 창구

- **무엇**: 오픈소스 FHIR R4 서버 v7.4.0 (Java 기반).
- **어디**: EC2 인스턴스 `i-0f3f223fd40217b12` (Public IP `15.164.21.221`)의 8080 포트.
- **데이터 저장소**: Aurora PostgreSQL (`patient-db-cluster...rds.amazonaws.com:5432`, DB `rarelink`, 스키마 `hapi`). HAPI가 자체적으로 ~150개 테이블을 자동 생성(Flyway).
- **호출 방식**: 표준 FHIR REST.
  - `GET /fhir/Patient?_count=20` → 환자 목록
  - `GET /fhir/Patient/{id}` → 환자 1명 상세
  - `GET /fhir/Observation?patient={id}&_count=50` → 검사결과
  - `GET /fhir/metadata` → 서버 capability 확인 (헬스체크)
- **인증**: 현재 데모는 토큰 없음(`AUTH_MODE=none`). 실 EMR 결선 시 SMART OAuth2.
- **누가 채워주나**: 현재는 비어있음. **MIMIC-IV → FHIR 변환 ETL**이 권미라·양희인 트랙. 100명 코호트 sampling 권장(자세한 결정사항은 `AURORA_FHIR_PHASE_MAPPING.md` §5).

### 4-2. SageMaker Endpoint — CXR AI 판독

- **무엇**: AWS SageMaker가 우리 DenseNet-121 모델 가중치(`model.pth`)를 호스팅. 이미지 POST 받으면 14개 CheXpert 레이블 확률 반환.
- **인스턴스 타입**: `ml.g4dn.xlarge` (NVIDIA T4 GPU).
- **연결 코드**: `lung_dx/aws/sagemaker_deployer.py` (배포), `lung_dx/phase1_xray/sagemaker_client.py` (호출).
- **모델 출처**: 배기태·허태웅 트랙. SooNet 내부 코드명.
- **프론트 직접 호출?**: ❌. 브라우저에서 SageMaker를 직접 호출하면 IAM 키 노출 위험. 항상 **Lambda 또는 FastAPI 백엔드 경유**.

### 4-3. Lambda 함수들 (Phase 1/2/3/4)

```
Phase 1: HPO 증상 추출 (Bedrock Claude 3 Haiku) — 한국어 임상노트 → HPO 코드들
Phase 2: CXR DenseNet 추론 (SageMaker 호출 wrapper)
Phase 3: 528 폐질환 가중 스코어링 (Python + YAML KB)
Phase 4: LLM 임상소견서 검증 (Bedrock Claude Sonnet 4.6 + 6종 가드레일)
```

각 Phase는 독립 Lambda. 입력은 JSON, 출력도 JSON. 결과는 Aurora에 FHIR 리소스로 저장될 예정(`RiskAssessment`, `ClinicalImpression` 등 — `AURORA_FHIR_PHASE_MAPPING.md` 참조).

로컬 개발용으로는 `lung_dx/` 폴더 안에 FastAPI 라우터(`lung_dx/api/router.py`)가 있어 `POST /api/v1/diagnose` 하나로 4단계를 다 돌릴 수도 있음.

### 4-4. S3 버킷 `say2-2team-bucket` — 모든 큰 파일들의 집

ap-northeast-2 (서울) 리전.

```
say2-2team-bucket/
├── models/chexnet/                    ← SageMaker용 model.tar.gz
├── cxr_images/                        ← 환자 CXR PNG (ImagingStudy.contentAttachment.url 참조)
├── reports/                           ← Phase 4 출력 소견서 (.md)
├── database/
│   ├── lung_disease_profiles_v3_2.yaml
│   ├── lab_reference_ranges_v9_5.yaml
│   └── ...
├── Phase_1/, Phase_2/, Phase_3/, Phase_4/ ← Lambda 코드·이벤트 샘플·아키텍처 문서
├── deploy/hapi-fhir/                  ← HAPI 배포 스크립트
└── Frontend/                          ← 정적 React 빌드 (S3 정적 호스팅 백업 후보)
```

`lung_dx/aws/s3_manager.py`가 boto3 wrapper. `upload`, `download`, `download_if_not_cached`, `upload_report` 함수 제공.

### 4-5. Aurora PostgreSQL — HAPI의 뒷마당

- **엔드포인트**: `patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com:5432`
- **엔진**: Aurora PostgreSQL 16.4
- **유저**: `hapi_user` (비밀번호는 AWS Secrets Manager의 `rare-link-ai/aurora/hapi-user`)
- **접근**: ❌ 프론트엔드도 Lambda도 **직접 SQL 치지 않음.** 항상 HAPI FHIR REST를 거침 (단일 access path 원칙).
- **보안그룹**: EC2(`sg-03b9bc5d95699b797`)에서 Aurora(`sg-019a357627f1594db`):5432만 허용.

### 4-6. Cognito (현재 mock) — 의사 로그인

지금 단계의 의사 로그인은 `src/auth/session.js`의 sessionStorage 기반 가짜 세션입니다. 발표 후 실 Cognito User Pool로 교체할 때 인터페이스가 호환되도록 `loadSession()/saveSession()` 추상화돼 있습니다.

### 4-7. Bedrock — LLM 호출 통로

AWS Bedrock = Anthropic Claude 같은 외부 LLM을 AWS 안에서 호출하는 게이트웨이. Phase 1(Haiku로 HPO 추출)과 Phase 4(Sonnet으로 소견서 검증)에서 사용. 키를 프론트에 꽂지 않고 Lambda에서만 호출.

---

## 5. EMR 이야기 — 우리는 왜 SMART on FHIR을 쓰나

### 5-1. EMR이란

병원에서 의사·간호사가 매일 쓰는 진료 시스템 = **Electronic Medical Record(EMR)**. 미국 대형 병원의 70% 이상이 Epic 또는 Cerner(현 Oracle Health)를 씁니다. 국내는 BESTCare 2.0(서울대병원), Wizmedi(연세), 자체 개발(삼성·서울아산) 등이 혼재.

EMR은 자기 데이터를 외부에 보여주기를 **굉장히 꺼립니다** — 환자정보보호·HIPAA·개인정보보호법 때문. 그래서 외부 앱이 환자 데이터를 보려면 표준 절차가 필요했고, 그게 **SMART on FHIR**입니다.

### 5-2. SMART on FHIR 핵심 시나리오 (EHR-launched)

```
1. 의사가 Epic 안에서 "Rare-Link AI 실행" 버튼 클릭
   → Epic이 우리 launch.html을 ?iss=...&launch=... 파라미터와 함께 열어줌
2. 우리 launch.js가 fhirclient의 SMART.oauth2.authorize() 호출
   → 브라우저가 Epic의 OAuth 동의 화면으로 리다이렉트
3. 의사 동의 → Epic이 우리 app.html로 ?code=... 와 함께 콜백
4. fhirclient가 code를 토큰으로 교환 → sessionStorage에 토큰 저장
5. 그 토큰으로 Epic FHIR API에 GET /Patient/{id} 등 호출 가능
```

코드는 `src/auth/smartLauncher.js`(시작), `launch.html`+`launch.js`(진입), `app.html`(콜백), `api/fhirAdapter.js`(데이터 사용).

### 5-3. 발표 데모에서는?

Epic·Cerner 정식 등록은 시간·계약 이슈로 불가. 그래서 **SMART Health IT Sandbox**(`launch.smarthealthit.org`) + **Synthea**(합성 환자 생성기)를 씁니다. Vendor 등록(`src/config/emrVendors.js`)에 Epic/Cerner는 `pending_contract` 상태로 두고, `resolveVendor()`가 sandbox로 자동 fallback합니다.

### 5-4. 발표 후 시나리오

| 단계 | 인증 | 데이터 출처 |
|---|---|---|
| W2 (현재) | mock | `MOCK_PATIENTS` 배열 |
| W3 | mock 또는 SMART Sandbox | Synthea 합성 환자 (sandbox) |
| W3+ | none | 우리 EC2 HAPI (Aurora에 MIMIC-IV 적재) |
| 발표 후 | SMART OAuth2 + Cognito | 실 EMR 벤더 (계약 후) |

---

## 6. 우리 AWS 자원 한눈에

| 자원 | 식별자 | 리전 | 용도 | 누가 만짐 |
|---|---|---|---|---|
| EC2 | `i-0f3f223fd40217b12` (2-2team-fhir-ec2) | ap-northeast-2 | nginx(:80) + HAPI FHIR(:8080) | 배기태·허태웅 (인프라), 박성수(프론트 배포) |
| Elastic IP | `eipalloc-023cbff1fa4fd21ea` → 15.164.21.221 | ap-northeast-2 | EC2 고정 IP | 인프라 |
| Key Pair | `say-2-2team` | ap-northeast-2 | EC2 SSH 접속 | 박성수 PEM 위치 확인 필요 |
| S3 Bucket | `say2-2team-bucket` | ap-northeast-2 | 모델·이미지·소견서·KB·Lambda 자산 | 전원 |
| Aurora | `patient-db-cluster.cluster-cxmiyawwwhbt...` | ap-northeast-2 | HAPI 백엔드 DB | 인프라 (직접 X) |
| SageMaker Endpoint | (배포 후 결정) | ap-northeast-2 | DenseNet 추론 | 배기태·허태웅 |
| Lambda × 4 | `rare-link-phase{1,2,3,4}-*` | ap-northeast-2 | 4단계 파이프라인 | 인프라 |
| Bedrock | (모델 호출 권한) | ap-northeast-2 | Claude Haiku/Sonnet 호출 | Phase 1·4 Lambda |
| Secrets Manager | `rare-link-ai/aurora/hapi-user` | ap-northeast-2 | DB 비밀번호 | 인프라 |
| IAM User | `aws-say2-9` (account 666803869796) | — | 박성수 작업용 | 박성수 |

**리전 통일**: 모든 자원이 ap-northeast-2 (서울)에 있어야 함. SageMaker만 us-east-1에 만들면 IAM 정책의 Resource ARN 수정 필요.

---

## 7. 권한(IAM) 현황 (2026-05-11 기준)

`frontend/docs/IAM_POLICY_README.md`에 자세히 있고, 요약하면:

| 영역 | 상태 |
|---|---|
| S3 (객체 R/W) | ✅ 동작 |
| EC2 (조회·SSH connect) | ⚠️ DescribeInstances 동작, SendSSHPublicKey 미확인 |
| SageMaker (Invoke) | ❌ 미확인 — W4 결선 시 필요 |
| Lambda (Invoke) | ❌ 미확인 |
| Cognito | ❌ AccessDenied |
| CloudFront | ❌ HTTPS 결선 시 필요 |

박성수가 W4에 SageMaker/Lambda invoke 권한을 인프라팀에 요청해야 함. 메시지 템플릿은 `IAM_POLICY_README.md` §5 참조.

---

## 8. 자주 묻는 질문

**Q. 프론트엔드가 SageMaker를 직접 호출하면 안 되나요?**
A. 안 됩니다. 브라우저 자바스크립트에 AWS Access Key를 박으면 그 키가 그대로 노출됩니다. 항상 Lambda 또는 FastAPI를 거쳐 SageMaker를 호출하고, 브라우저는 그 중간 API의 결과만 받습니다.

**Q. 환자 데이터는 어디까지 sessionStorage에 저장되나요?**
A. **환자 식별정보·진료기록은 절대 저장 금지**입니다 (개인정보보호법·HIPAA). `session.js` 주석에도 명시. 저장되는 건 의사 메타데이터(이름·소속·EMR 벤더 키)와 SMART 토큰뿐.

**Q. mock 모드와 real 모드 어떻게 구분되나요?**
A. `frontend/.env`의 `VITE_USE_MOCK`. `true`면 가짜 환자, `false`면 SMART OAuth2 발동 또는 EC2 HAPI 호출.

**Q. HAPI FHIR 서버에 지금 환자가 들어있나요?**
A. 거의 비어있습니다. MIMIC-IV 데이터를 FHIR로 변환해 적재하는 작업이 권미라·양희인 트랙. 100명 코호트 sampling이 권장 진행 순서 (`AURORA_FHIR_PHASE_MAPPING.md` §3).

**Q. 528개 폐질환 데이터는 어디 있나요?**
A. S3 `say2-2team-bucket/database/lung_disease_profiles_v3_2.yaml`. Lambda Phase 3가 시작 시 로드해 인메모리로 매칭. DB에 넣지 않음 (참조 데이터 ≠ 환자 데이터).

**Q. FHIR이랑 HL7이랑 같은 거에요?**
A. HL7은 단체 이름 + 그 단체가 만든 의료 표준 시리즈 전체. v2, v3, CDA, FHIR이 다 HL7 소속. FHIR은 그중 가장 최신이고 REST+JSON 기반이라 웹 친화적. 우리는 FHIR R4를 씁니다.

---

## 9. 다음에 만질 것

- **W3 진행 중**: SageMaker endpoint 배포 → 프론트 LR 막대 화면(#03,#04) 연결.
- **W3 후반**: MIMIC → FHIR ETL로 Aurora에 환자 100명 적재.
- **W4**: Heatmap (Grad-CAM) 오버레이, RAG 유사 케이스, 리포트 뷰어.
- **W5**: 시나리오 녹화·발표 자료 마무리. CloudFront로 HTTPS 결선(SMART 실 발동에 필수).

---

## 10. 참고 문서 (이 문서가 흐릿할 때 깊게 들어갈 곳)

- `CLAUDE.md` — 프로젝트 헌법. 결정사항·금지사항·디자인 원칙.
- `frontend/README.md` — 프론트 실행 매뉴얼.
- `frontend/docs/IAM_POLICY_README.md` — AWS 권한 요청서.
- `AURORA_FHIR_PHASE_MAPPING.md` — Phase 입력 ↔ FHIR 리소스 매핑, 결손 데이터.
- `USAGE_GUIDE.md` — `lung_dx` CLI 사용법.
- `Rare-Link-AI_UIUX_설계제안서.pdf` — UI/UX 설계 근거 (박성수, 2026-04-21).

---

## ⚠️ 부록 · 보안 점검 (이 문서 읽는 김에 같이)

1. `C:\Users\tjdtn\Documents\rare-link-ai-frontend\credentials` 파일의 AWS Access Key가 평문 상태입니다. 그 파일이 `git status`에 잡히지 않는지 확인하세요. 잡힌다면 즉시 `.gitignore`에 추가 + 키 폐기.
2. AWS credential의 표준 위치는 `~/.aws/credentials` (Windows: `C:\Users\<유저>\.aws\credentials`). 그쪽으로 옮기면 boto3/AWS CLI가 자동 로드합니다.
3. SageMaker invoke·Lambda invoke 권한은 W4 진입 전에 인프라팀에 요청 (`IAM_POLICY_README.md` §5 템플릿).
4. EC2 22번 포트 SSH가 open되어 있습니다. 보안그룹에서 본인 IP만 허용으로 좁힐 것을 권장.
5. `frontend/.env`에 SMART clientSecret 같은 비밀값을 절대 넣지 마세요. Vite는 `VITE_` 접두 변수를 **번들에 그대로 노출**합니다.

