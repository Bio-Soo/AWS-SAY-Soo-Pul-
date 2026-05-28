/**
 * EMR Vendor Registry — 의사 소속 EMR 별 SMART on FHIR endpoint 매핑.
 *
 * ⚠️ 현재 데모 단계: 프론트 하드코딩.
 *    발표 후 DynamoDB + API Gateway 로 이관 예정 (interface 호환 유지).
 *
 * status:
 *   'active'             — 실제 SMART 발동 가능 (sandbox 또는 계약 완료 벤더)
 *   'pending_contract'   — 벤더 계약 진행 중. 데모에선 sandbox 로 fallback.
 *
 * 표준:
 * - SMART App Launch v2.2.0  https://hl7.org/fhir/smart-app-launch/
 * - FHIR R4 base URL         https://www.hl7.org/fhir/R4/
 */

export const EMR_VENDORS = {
  smart_sandbox: {
    key:       'smart_sandbox',
    label:     'SMART Health IT Sandbox (Synthea)',
    fhirBase:  'https://launch.smarthealthit.org/v/r4/fhir',
    clientId:  'rare-link-ai',
    scope:     'launch/patient openid fhirUser patient/*.read',
    status:    'active',
    note:      '무료 공개 sandbox · Synthea 합성 환자 · 발표 데모 메인',
  },

  epic: {
    key:       'epic',
    label:     'Epic Systems',
    fhirBase:  'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
    clientId:  'PENDING_VENDOR_CONTRACT',
    scope:     'launch/patient openid fhirUser patient/*.read',
    status:    'pending_contract',
    note:      'Epic App Orchard(현 Vendor Services) 등록 필요 · 데모는 sandbox 로 우회',
  },

  cerner: {
    key:       'cerner',
    label:     'Cerner / Oracle Health',
    fhirBase:  'https://fhir-myrecord.cerner.com/r4',
    clientId:  'PENDING_VENDOR_CONTRACT',
    scope:     'launch/patient openid fhirUser patient/*.read',
    status:    'pending_contract',
    note:      'Cerner Code Console 등록 필요 · 데모는 sandbox 로 우회',
  },
};

export const FALLBACK_VENDOR_KEY = 'smart_sandbox';

/**
 * 의사 emrVendor 키 → 실 호출 가능한 vendor 설정 반환.
 *
 * - active        : 그대로 반환
 * - pending_contract / unknown : sandbox 로 fallback + fallback 플래그 ON
 *
 * @param {string} vendorKey
 * @returns {{ vendor: object, didFallback: boolean }}
 */
export function resolveVendor(vendorKey) {
  const v = EMR_VENDORS[vendorKey];
  if (v && v.status === 'active') {
    return { vendor: v, didFallback: false };
  }
  return {
    vendor:      EMR_VENDORS[FALLBACK_VENDOR_KEY],
    didFallback: true,
  };
}

/** UI 드롭다운 등에서 사용. */
export function listVendors() {
  return Object.values(EMR_VENDORS);
}
