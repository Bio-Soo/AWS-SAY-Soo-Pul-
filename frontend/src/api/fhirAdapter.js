/**
 * FHIR Adapter — converts FHIR R4 resources to Rare-Link AI UI shapes.
 *
 * 이 파일은 "데이터 형식 계약(contract)"을 명문화합니다.
 * - Mock 데이터(LoginWorklist.jsx 의 MOCK_PATIENTS)와
 * - 진짜 FHIR 데이터가 똑같은 모양으로 UI에 들어가도록 보장합니다.
 *
 * 인증 모드 (VITE_FHIR_AUTH_MODE):
 *   smart  · SMART on FHIR OAuth2 (EHR-launched, fhirclient v2 표준)
 *   none   · raw FHIR REST (EC2 HAPI 등 OAuth 없는 서버)
 *
 * 표준:
 * - HL7 FHIR R4: https://www.hl7.org/fhir/R4/
 * - Patient: https://www.hl7.org/fhir/R4/patient.html
 * - Observation: https://www.hl7.org/fhir/R4/observation.html
 * - Condition: https://www.hl7.org/fhir/R4/condition.html
 */

import FHIR from 'fhirclient';

const AUTH_MODE = (import.meta.env.VITE_FHIR_AUTH_MODE || 'smart').toLowerCase();
const BASE_URL  = import.meta.env.VITE_FHIR_BASE_URL || '';

/**
 * SMART on FHIR 연결 상태 확인
 * sessionStorage에 토큰이 저장되어 있으면 true.
 */
export function isSmartAuthorized() {
  return sessionStorage.getItem('SMART_AUTHORIZED') === 'true';
}

/**
 * 현재 환경에서 실서버 fetch가 가능한지 검사.
 * LoginWorklist의 useEffect 가 mock fallback 결정에 사용.
 */
export function canFetchFhir() {
  if (AUTH_MODE === 'none') return Boolean(BASE_URL);
  return isSmartAuthorized();
}

/**
 * FHIR 클라이언트 인스턴스 가져오기.
 * - smart 모드: OAuth2 토큰 교환 끝난 상태에서 ready 클라이언트 반환
 * - none  모드: serverUrl 만으로 anonymous 클라이언트 생성 (FHIR.client API)
 *
 * 두 경로 모두 client.request(path) 인터페이스를 동일하게 제공.
 */
export async function getClient() {
  if (AUTH_MODE === 'none') {
    if (!BASE_URL) throw new Error('VITE_FHIR_BASE_URL 미설정 (auth=none 모드)');
    // fhirclient v2 의 standalone 클라이언트
    return FHIR.client({ serverUrl: BASE_URL });
  }
  return await FHIR.oauth2.ready();
}

/**
 * 연결 헬스체크 — CapabilityStatement 호출 (FHIR 표준 metadata endpoint).
 * 200 OK + resourceType=CapabilityStatement 면 healthy.
 * UI 의 connection indicator 가 호출.
 */
export async function pingFhir() {
  if (AUTH_MODE === 'none') {
    if (!BASE_URL) throw new Error('VITE_FHIR_BASE_URL 미설정');
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/metadata`, {
      headers: { Accept: 'application/fhir+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      ok: data.resourceType === 'CapabilityStatement',
      software: data.software?.name || 'unknown',
      version: data.fhirVersion || '?',
      url: BASE_URL,
    };
  }
  // smart 모드: ready 클라이언트의 state.serverUrl 로 metadata 조회
  const client = await FHIR.oauth2.ready();
  const data = await client.request('metadata');
  return {
    ok: data.resourceType === 'CapabilityStatement',
    software: data.software?.name || 'unknown',
    version: data.fhirVersion || '?',
    url: client.state.serverUrl,
  };
}

/**
 * Synthea 코호트에서 폐 질환 관련 환자 N명 가져오기.
 *
 * MVP 전략: Patient 리소스 검색 → 각 환자의 Condition·Observation 동시 조회
 * (성능을 위해 W3에서 _include 파라미터 또는 GraphQL 도입 검토)
 */
export async function fetchPatients(client, count = 20) {
  const bundle = await client.request(`Patient?_count=${count}`);
  const patients = bundle.entry?.map(e => e.resource) || [];

  // 각 환자에 대해 condition / observation 추가 조회
  // (병렬 fetch로 latency 최소화)
  return await Promise.all(
    patients.map(async (p) => {
      const [conditionsBundle, obsBundle] = await Promise.all([
        client.request(`Condition?patient=${p.id}&_count=5&clinical-status=active`),
        client.request(`Observation?patient=${p.id}&_count=10&_sort=-date`),
      ]);

      return toUIShape(
        p,
        conditionsBundle.entry?.map(e => e.resource) || [],
        obsBundle.entry?.map(e => e.resource) || [],
      );
    }),
  );
}

/**
 * FHIR R4 HumanName.family 는 0..1 string (배열 아님).
 * 한글 환자: '김○○' / 외국인: 'John S.' 로 마스킹 — BiText helper와 페어링.
 */
const HAS_HANGUL = /[가-힣]/;
function maskName(humanName) {
  if (!humanName) return '환자';
  // R4: family=string, given=string[]. 구버전 STU3는 family가 array일 수 있어 양쪽 방어.
  const familyRaw = Array.isArray(humanName.family) ? humanName.family[0] : humanName.family;
  const givenRaw  = Array.isArray(humanName.given)  ? humanName.given[0]  : humanName.given;
  const family = (familyRaw || '').trim();
  const given  = (givenRaw  || '').trim();

  // 한글 성씨 → 김○○
  if (family && HAS_HANGUL.test(family)) {
    return `${family[0]}○○`;
  }
  // 영문: 'John Smith' → 'John S.'  (full given + last initial)
  if (given && family) return `${given} ${family[0]}.`;
  if (family) return family;
  if (given)  return given;
  return humanName.text || '환자';
}

/**
 * FHIR 리소스 → UI 형식 변환
 * MOCK_PATIENTS 의 객체 모양과 1:1 매칭.
 */
export function toUIShape(patient, conditions = [], observations = []) {
  const maskedName = maskName(patient.name?.[0]);

  // 나이 계산
  const age = patient.birthDate
    ? Math.floor((Date.now() - new Date(patient.birthDate)) / (365.25 * 24 * 60 * 60 * 1000))
    : null;

  // 성별 매핑
  const sex = { male: 'M', female: 'F' }[patient.gender] || '?';

  // 주호소: 가장 최근 active condition 으로 추정
  // (Synthea는 "chief complaint" 필드가 명시적이지 않음 → Condition으로 근사)
  const complaint = conditions[0]?.code?.text
    || conditions[0]?.code?.coding?.[0]?.display
    || '주호소 정보 없음';

  // 알러지 — AllergyIntolerance 리소스는 별도 호출 필요. W3에 추가.
  const allergy = null;

  return {
    // 식별
    mrn:  patient.id,
    name: maskedName,
    sex,
    age,

    // FHIR 원본 (디버깅/전체 화면에서 활용)
    _fhir: {
      patient,
      conditions,
      observations,
    },

    // 화면 전용
    time:    '08:30',           // FHIR Encounter.period.start로 매핑 (W3)
    visit:   conditions.length > 0 ? '재진' : '초진',
    complaint,
    allergy,

    // CXR / AI 상태 — 우리 시스템 자체 메타데이터
    // (Synthea에 ImagingStudy가 있는 환자는 'arrived', 없으면 'pending')
    cxr:    'pending',          // W3에서 ImagingStudy 조회로 결정
    status: 'pending',          // 우리 SageMaker 호출 결과
    rare:   false,
    dontMiss: false,
    topDx:  null,
    preview: null,
  };
}

/**
 * 단일 환자 상세 데이터 조회 (워크스페이스 화면용 · W3)
 */
export async function fetchPatientDetail(client, patientId) {
  const [patient, conditionsBundle, obsBundle, allergiesBundle] = await Promise.all([
    client.request(`Patient/${patientId}`),
    client.request(`Condition?patient=${patientId}&_count=20`),
    client.request(`Observation?patient=${patientId}&_count=50&_sort=-date`),
    client.request(`AllergyIntolerance?patient=${patientId}`),
  ]);

  return toUIShape(
    patient,
    conditionsBundle.entry?.map(e => e.resource) || [],
    obsBundle.entry?.map(e => e.resource) || [],
  );
}

/**
 * LOINC 코드 → 우리 시스템 검사명 매핑
 * (HPO-LR 엔진에 넘기기 전 표준화 단계)
 *
 * Synthea는 LOINC 코드를 사용. 우리 KB도 LOINC 호환 가능하게 설계됨.
 */
export const LOINC_TO_LAB = {
  '2532-0':  'LDH',     // Lactate dehydrogenase
  '1988-5':  'CRP',     // C-reactive protein
  '94508-9': 'KL-6',    // KL-6 (참고: Synthea는 이 항목 없을 수 있음)
  '20448-7': 'SP-D',    // Surfactant protein D
  // ... 추가 필요 시 W3에 확장
};

export function extractLabValue(observations, loincCode) {
  const obs = observations.find(o =>
    o.code?.coding?.some(c => c.system === 'http://loinc.org' && c.code === loincCode)
  );
  return obs?.valueQuantity?.value ?? null;
}
