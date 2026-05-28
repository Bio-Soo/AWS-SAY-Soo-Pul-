# `/mock_fhir/` · 로컬 정적 mock FHIR + 진단 결과

**용도**: 화면 개발 중 fetch로 받아 쓸 정적 JSON. 진짜 HAPI/SageMaker가 결선되기 전까지의 stand-in.

**생성**: `python scripts/build_local_mock.py` (5개 합성환자 Bundle을 분해해서 자동 생성)

**서빙**: Vite가 `frontend/public/`을 자동으로 `/` 경로에 정적 자산으로 서빙.
- 로컬: `http://localhost:5173/mock_fhir/Patient/26-145982.json`
- EC2: `http://15.164.21.221/Frontend/mock_fhir/Patient/26-145982.json`
- S3 (배포 후): `https://say2-2team-bucket.s3.../Frontend/mock_fhir/...`
- 같은 상대 경로 (`/mock_fhir/...`)가 어디서나 작동

## 구조

```
mock_fhir/
├── README.md                                  (이 파일)
├── metadata.json                              CapabilityStatement (헬스체크용)
│
├── Patient/
│   ├── _count=20.json                         5명 목록 (searchset Bundle)
│   ├── 26-145982.json  김○○ · CAP            단일 Patient 리소스
│   ├── 26-098234.json  이○○ · COPD exac
│   ├── 26-204017.json  박○○ · IPF (rare)
│   ├── 26-301102.json  정○○ · LAM  (rare)
│   └── 26-415523.json  최○○ · 폐 종괴 (애매)
│
├── Observation/patient={mrn}.json             HPO + Lab + Vital 묶음 (searchset)
├── Condition/patient={mrn}.json               working diagnosis (searchset)
├── Encounter/patient={mrn}.json
├── ImagingStudy/patient={mrn}.json            CXR 메타 + S3 endpoint 참조
├── DocumentReference/patient={mrn}.json       한국어 임상노트 (base64)
├── Endpoint/patient={mrn}.json                S3 CXR URL
│
└── mock_results/{mrn}.json                    Phase 1·2·3·4·5·F 진단 결과
                                               (delay_ms 포함 — progressive 시뮬용)
```

## URL 매핑 (가짜 → 진짜 FHIR 의미)

| 가짜 URL (정적 파일) | 의미하는 FHIR REST |
|---|---|
| `/mock_fhir/Patient/_count=20.json` | `GET /fhir/Patient?_count=20` |
| `/mock_fhir/Patient/26-145982.json` | `GET /fhir/Patient/26-145982` |
| `/mock_fhir/Observation/patient=26-145982.json` | `GET /fhir/Observation?patient=26-145982` |
| `/mock_fhir/DocumentReference/patient=26-145982.json` | `GET /fhir/DocumentReference?patient=26-145982` |

진짜 HAPI/EMR 결선 시 base URL만 바꾸면 동일한 코드가 작동.

## `mock_results/{mrn}.json` 구조

각 환자의 Phase 1~F 결과를 미리 만들어 둔 것. 워크스페이스 화면이 "진짜 분석"한 것처럼 보이기 위함.

```jsonc
{
  "execution_id": "exec-mock-26-145982",
  "case_id": "26-145982",
  "overall_status": "DONE",
  "phases": {
    "phase1": {"status": "succeeded", "delay_ms": 1500,
               "result": {"positive_hpos": [...HPO들...]}},
    "phase2": {"status": "succeeded", "delay_ms": 2000,
               "result": {"labels_top": [{"name":"Pneumonia","score":0.92}, ...],
                          "heatmap_url": "/mock_fhir/heatmaps/26-145982.png"}},
    "phase3": {"status": "succeeded", "delay_ms": 800,
               "result": {"label": "draft", "top_n": [...]}},
    "phase4": {"status": "succeeded", "delay_ms": 4500,
               "result": {"revised_ranking": [...], "guardrails_passed": [...], "note": ""}},
    "phase5": {"status": "succeeded", "delay_ms": 1500,
               "result": {"rare_candidates": [...]}},
    "final":  {"status": "succeeded", "delay_ms": 3500,
               "result": {"report_url": "/mock_fhir/reports/26-145982.md",
                          "similar_cases_count": 5}}
  }
}
```

각 phase의 `delay_ms`를 그대로 setTimeout으로 쓰면 실제 backend가 응답하는 시간감으로 progressive 렌더링.

## 워크플로우

### 화면 만지면서 즉시 확인

```powershell
cd frontend
npm run dev
# http://localhost:5173 자동 오픈, .jsx 저장하면 0.5초 안에 reload
```

### Mock 데이터 수정

1. `scripts/synthetic_patients/{patient}.bundle.json` 또는 `.note.txt` 직접 편집
2. `python scripts/build_local_mock.py --clean` 재실행
3. Vite dev 켜져 있으면 자동 갱신

또는 `/mock_fhir/...` 의 JSON을 직접 편집해도 즉시 반영 (다음 빌드 때 `--clean` 안 하면 보존).

### 배포

`npm run build`가 `public/` 내용을 자동으로 `dist/`에 복사. EC2/S3 배포 시 같이 올라감.

## 환자 추가 절차

1. `scripts/synthetic_patients/`에 `patient-06-<scenario>.bundle.json` + `.note.txt` 추가
2. `scripts/build_local_mock.py`의 `PATIENT_NAMES` 리스트에 `"patient-06-<scenario>"` 추가
3. `derive_mock_result()`의 `rankings` 딕셔너리에 해당 시나리오 키 추가
4. `python scripts/build_local_mock.py --clean` 실행
5. `npm run dev` 새로고침

## fhirAdapter.js 결선 (선택 · 아직 안 함)

지금은 `LoginWorklist.jsx` 안의 `MOCK_PATIENTS` 인라인 배열이 환자 목록 출처. mock_fhir/ 파일들과는 별개로 동작.

연결하려면 (다음 작업 후보):
- `.env.development.local`에 `VITE_FHIR_AUTH_MODE=local-mock` + `VITE_FHIR_BASE_URL=/mock_fhir`
- `fhirAdapter.js`의 `getClient()` / `fetchPatients()` 등이 `/mock_fhir/Patient/_count=20.json` 같은 정적 경로를 fetch 하도록 매핑 레이어 추가
- LoginWorklist에서 MOCK_PATIENTS 대신 `fetchPatients(client)` 사용

이건 박성수님이 화면 작업하면서 점진적으로 갈아끼우는 게 안전.
