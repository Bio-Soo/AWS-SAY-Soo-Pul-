# Cognito 인증 · Rare-Link AI

의사 로그인 인증을 위한 AWS Cognito User Pool 구성·계정·frontend 연동 문서입니다.
(작성 2026-05-21, Region `ap-northeast-2`)

기존의 `seedDoctors.js` mock 인증을 제거하고 Cognito User Pool 실제 인증으로
전환했습니다.

---

## 1. User Pool / App Client

| 항목 | 값 |
|---|---|
| User Pool 이름 | `say2-2team-rare-link-pool` |
| **User Pool ID** | `ap-northeast-2_CMtZTRCTa` |
| App Client 이름 | `say2-2team-rare-link-spa` |
| **App Client ID** | `1280u1fg8gbvt1g21sv8dn4246` |
| Client Secret | 없음 (SPA public client) |
| Auth Flows | `ALLOW_USER_SRP_AUTH`, `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH` |
| 토큰 유효기간 | ID/Access 1시간 · Refresh 30일 |
| 가입 정책 | `AllowAdminCreateUserOnly=true` — **self-signup 차단**, 관리자만 계정 생성 |

### 1.1 Custom Attributes

의사 메타데이터는 표준 속성(`name`, `email`) 외에 custom attribute 로 저장되며,
로그인 시 ID 토큰 payload 에 실려 옵니다.

| 속성 | 용도 |
|---|---|
| `custom:institution` | 소속 병원 |
| `custom:department` | 진료과 |
| `custom:role` | 직책 |
| `custom:license_no` | 의사 면허번호 |
| `custom:emr_vendor` | EMR 벤더 (`smart_sandbox` / `epic` / `cerner`) |

> ⚠️ custom attribute 는 User Pool 생성 시점에만 schema 에 추가 가능합니다.
> 신규 속성이 필요하면 새 속성을 추가(mutable)할 수는 있으나 기존 속성 삭제·타입
> 변경은 불가하므로 신중히 결정합니다.

### 1.2 비밀번호 정책

- 최소 8자, **대문자·소문자·숫자·특수문자 각 1개 이상** 필수
- 임시 비밀번호 유효기간 30일

---

## 2. 의사 계정 (병원 3개 · 5명)

데모 시드 계정. 비밀번호는 전부 `DemoPass123!` 입니다.

| 병원 | 로그인 ID | 이름 | 직책 | 면허번호 | EMR 벤더 |
|---|---|---|---|---|---|
| 성균관대학교병원 | `jeong.ms` | 정민수 | 호흡기내과 과장 | MD-2010-1001 | smart_sandbox |
| 성균관대학교병원 | `park.jh` | 박지훈 | 호흡기내과 전임의 | MD-2019-4471 | smart_sandbox |
| 삼성서울병원 | `kim.mj` | 김민준 | 호흡기내과 전임의 | MD-2018-5547 | epic |
| 서울아산병원 | `lee.sj` | 이수진 | 호흡기내과 전임의 | MD-2015-3321 | cerner |
| 서울아산병원 | `choi.ya` | 최영아 | 호흡기내과 임상강사 | MD-2020-7788 | cerner |

> 데모 도메인 이메일(`@skku.test` 등)은 실제 발송되지 않습니다.

---

## 3. Frontend 연동

### 3.1 구조

| 파일 | 역할 |
|---|---|
| `src/auth/cognito.js` | Cognito User Pool 연결 · `signIn()` · `signOutCognito()` |
| `src/LoginWorklist.jsx` | `LoginScreen.handleLogin` 이 `cognitoSignIn()` 호출 |
| `src/auth/session.js` | 로그인 후 sessionStorage 세션 (1시간 TTL) — 기존 그대로 |
| `.env.production` | `VITE_COGNITO_POOL_ID` · `VITE_COGNITO_CLIENT_ID` |

- 패키지: `amazon-cognito-identity-js`
- 로그인 흐름: 의사 ID + 비밀번호 → `authenticateUser` (SRP) → ID 토큰 →
  custom attributes 를 `doctor` 객체로 변환 → 세션 저장
- 로그아웃 시 `signOutCognito()` 로 Cognito 로컬 세션도 정리

### 3.2 환경변수 (`.env.production`)

```
VITE_COGNITO_POOL_ID=ap-northeast-2_CMtZTRCTa
VITE_COGNITO_CLIENT_ID=1280u1fg8gbvt1g21sv8dn4246
```

> 환경변수 누락 시 `cognito.js` 의 `isCognitoConfigured()` 가 `false` 를 반환하고
> 로그인 시 "인증 설정이 누락되었습니다" 오류를 표시합니다.

---

## 4. 계정 관리

### 4.1 계정 추가

```bash
aws cognito-idp admin-create-user \
  --region ap-northeast-2 \
  --user-pool-id ap-northeast-2_CMtZTRCTa \
  --username <로그인ID> \
  --message-action SUPPRESS \
  --user-attributes \
    Name=name,Value=<이름> \
    Name=email,Value=<이메일> \
    Name=email_verified,Value=true \
    Name=custom:institution,Value=<병원> \
    Name=custom:department,Value=<진료과> \
    Name=custom:role,Value=<직책> \
    Name=custom:license_no,Value=<면허번호> \
    Name=custom:emr_vendor,Value=<emr벤더>

# 영구 비밀번호 설정 (FORCE_CHANGE_PASSWORD 상태 회피)
aws cognito-idp admin-set-user-password \
  --region ap-northeast-2 \
  --user-pool-id ap-northeast-2_CMtZTRCTa \
  --username <로그인ID> \
  --password '<비밀번호>' --permanent
```

5명 일괄 시드 스크립트: [`cognito_seed.py`](./cognito_seed.py)
(boto3 기반 — 한글 속성 인코딩 안전). User Pool schema 정의는
[`cognito_schema.json`](./cognito_schema.json) 참고.

### 4.2 비밀번호 재설정

```bash
aws cognito-idp admin-set-user-password \
  --region ap-northeast-2 --user-pool-id ap-northeast-2_CMtZTRCTa \
  --username <로그인ID> --password '<새비밀번호>' --permanent
```

### 4.3 계정 삭제 / 목록

```bash
aws cognito-idp admin-delete-user --region ap-northeast-2 \
  --user-pool-id ap-northeast-2_CMtZTRCTa --username <로그인ID>

aws cognito-idp list-users --region ap-northeast-2 \
  --user-pool-id ap-northeast-2_CMtZTRCTa \
  --query 'Users[].{ID:Username,Status:UserStatus}' --output table
```

---

## 5. 운영 방향 · EMR 기반 계정 provisioning

Rare-Link AI 의 의사 계정은 **EMR 에 이미 등록·검증된 의사**가 사용합니다.
따라서 self-signup 이 아니라 다음 흐름을 전제로 합니다.

```
EMR 시스템 → (의사 계정 발급 요청) → Rare-Link AI 백엔드 → Cognito admin-create-user
```

- User Pool 의 `AllowAdminCreateUserOnly=true` 설정이 이 모델을 강제합니다.
- 현재(데모 단계)는 위 5명을 `admin-create-user` 로 수동 시드한 상태입니다.
- **향후 자동화**: EMR 의 계정 요청을 받는 백엔드 endpoint
  (예: `POST /api/v1/admin/provision-doctor`)를 만들고, 내부에서
  `cognito-idp admin-create-user` 를 호출하는 구조로 확장합니다.
  병원·면허 등 EMR 메타데이터는 custom attributes 로 그대로 저장됩니다.
- 검증 hook 이 필요하면 Pre Sign-up / Post Confirmation Lambda 트리거를
  User Pool 에 연결할 수 있습니다.

---

## 6. 관련 자원

| 자원 | 식별자 |
|---|---|
| User Pool | `ap-northeast-2_CMtZTRCTa` |
| App Client | `1280u1fg8gbvt1g21sv8dn4246` |
| Region | `ap-northeast-2` (Seoul) |
| AWS Account | `666803869796` |
| Frontend 배포 | CloudFront `d300v14l8u0wx7.cloudfront.net` |
