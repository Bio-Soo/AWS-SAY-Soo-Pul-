# IAM Policy Request · Rare-Link AI Frontend

이 폴더는 박성수(Frontend Lead)가 인프라 팀(배기태·허태웅)에 IAM 권한 추가를
요청할 때 사용하는 문서입니다.

## 1. 대상

- **IAM 사용자**: `aws-say2-9` (Account: `666803869796`)
- **AWS Region**: `ap-northeast-2` (Seoul)
- **버킷**: `s3://say2-2team-bucket`

## 2. 정책 파일

- [`iam-policy.json`](./iam-policy.json) — 그대로 customer-managed policy 또는
  inline policy 로 attach 가능. ARN 의 `<USER_POOL_ID>`·`<DENSENET_ENDPOINT_NAME>`·
  `<API_ID>` placeholder 는 실제 값으로 치환.

## 3. 현재 권한 상태 (2026-05-11 확인)

| 영역 | Action | 상태 |
|---|---|---|
| STS | `GetCallerIdentity` | ✅ 동작 |
| S3 | `ListBucket`, `GetObject/PutObject/DeleteObject` | ✅ 동작 |
| S3 정적 호스팅 | `GetBucketWebsite`, `PutBucketWebsite`, `PutBucketPolicy`, `PutPublicAccessBlock` | ⚠️ 미확인 (시도 필요) |
| EC2 | `DescribeInstances`, `DescribeAddresses`, `DescribeSecurityGroups` | ✅ 동작 |
| EC2 Instance Connect | `SendSSHPublicKey` | ⚠️ 미확인 (SSH 배포 시 필요) |
| SSM | `DescribeInstanceInformation`, `StartSession` | ⚠️ 가능하지만 EC2에 SSM agent 미설치 |
| Cognito | `ListUserPools` | ❌ AccessDenied |
| SageMaker | `ListEndpoints`, `InvokeEndpoint` | ❌ 미확인 (Cognito 거부됐으니 동일 가능성) |
| Lambda | `InvokeFunction` | ❌ 미확인 |
| DynamoDB | `*` | ❌ 미확인 |
| CloudWatch Logs | `*` | ❌ 미확인 |

### EC2 라이브 사이트 정보 (2026-05-11)

- **인스턴스**: `i-0f3f223fd40217b12` · `2-2team-fhir-ec2` · t3.large · ap-northeast-2
- **Public IP**: `15.164.21.221` (Elastic IP `eipalloc-023cbff1fa4fd21ea`)
- **서비스**:
  - Port 80 (HTTP): nginx 정적 호스팅, `/Frontend/` prefix 로 React 앱 서빙 — 현재 **4일 전 빌드 (`main-CHWXTtVT.js`) 가 떠 있음**
  - Port 8080 (HTTP): HAPI FHIR R4 Server 7.4.0
  - Port 4004: 용도 미상
  - Port 22 (SSH): open
- **Key Pair**: `say-2-2team` (PEM 파일 위치 박성수 확인 필요)
- **SSM agent**: 미설치 (`InstanceInformationList: []`)

## 4. Tier 분류 — 단계적 적용 가능

인프라 팀이 한 번에 다 붙이기 부담스러우면 Tier 단위로 분리 적용 권장.

| Tier | Sid | 적용 시기 | 비고 |
|---|---|---|---|
| **0** | `STS_*`, `S3_FrontendBucket_ObjectRW_*` | 이미 가능 | 박성수 작업·배포 진행 중 |
| **1 (즉시)** | `EC2_FhirInstance_DescribeAndConnect` (특히 `ec2-instance-connect:SendSSHPublicKey`) | EC2 라이브 사이트에 새 빌드 배포할 때 | PEM 키 없이도 SSH 가능 |
| **2 (즉시)** | `S3_FrontendBucket_DeployAndConfig` 의 `PutBucketWebsite/PutBucketPolicy/PutPublicAccessBlock` | S3 정적 호스팅으로 백업 라이브 사이트 활성화 시 | HTTP only |
| **3 (W5+)** | `CloudFront_Distribution_Manage` | HTTPS 결선 시 | SMART 실 발동에 필수 |
| **3 (W4)** | `SageMaker_*`, `Lambda_*`, `CloudWatchLogs_*` | Heatmap·HPO-LR 결선 시 | 추론 endpoint 호출 |
| **4 (W5+)** | `Cognito_*` | mock → 실 Cognito 이관 시 | 시드 의사 실 등록 |
| **5 (이관)** | `DynamoDB_*`, `APIGateway_*` | Vendor Registry 백엔드 이관 시 | 발표 후 |

## 5. 인프라 팀에 보낼 메시지 예시

> 기태·태웅, 박성수입니다.
>
> 프론트엔드 W4 들어가면서 SageMaker invoke + Lambda invoke + S3 정적 호스팅 활성화
> 권한이 필요합니다. 발표 후 실 Cognito 결선까지 단계적으로 권한 더 받아야 해서
> 한꺼번에 정리해서 보냅니다.
>
> 첨부 `iam-policy.json` 그대로 customer-managed policy 또는 inline 으로
> `aws-say2-9` 사용자에 attach 부탁드립니다. ARN 의 `<USER_POOL_ID>` 같은
> placeholder 는 실제 만들어두신 리소스 값으로 치환해주세요.
>
> 한 번에 부담스러우면 **Tier 1·2** 만 먼저 → 그 다음 Tier 3 (SageMaker·Lambda)
> 순서가 좋습니다. README 의 Tier 표 참고.

## 6. 능동 flag (인프라 팀 검토용)

- **`Resource: "*"` 가 있는 2 Sid** (`STS_Identity_ReadOnly`, `SageMaker_Endpoint_Describe`,
  `CloudFront_Distribution_Manage`): 메타 조회·관리용. 더 좁히려면 endpoint·distribution
  ARN 으로 한정 가능.
- **`Cognito_UserPool_Manage_TestUsers` 의 `AdminCreateUser/AdminSetUserPassword`**:
  운영 환경에선 admin 권한 분리 권장 (자기 가입자 비번 임의 설정 가능). 데모·시드
  의사 등록용으로만 부여 시 OK.
- **Lambda·DynamoDB ARN 의 `rare-link-*` prefix**: 인프라 팀이 다른 명명 규칙 쓰면
  ARN 패턴 조정 필요. 사전 합의 부탁.
- **Region 통일 `ap-northeast-2`**: SageMaker endpoint 가 us-east-1 에 있다면
  해당 Sid 의 region 부분 수정 필요.
- **`s3:PutBucketPolicy` 는 위험 가능**: 잘못 쓰면 버킷 전체 public 노출. 박성수가
  사용할 때 `Frontend/` 만 public read 허용하는 정책으로 제한할 예정.

## 7. 관련 컨텍스트

- 메모리: `reference_handoff_package.md` (AWS 리소스 현황)
- 프로젝트 헌법: `frontend/CLAUDE.md` (또는 모노레포 루트의 CLAUDE.md)
- 발표 데드라인: **2026-05-28** (W4 진행 중)
