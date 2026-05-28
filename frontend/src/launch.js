// SMART on FHIR launch endpoint (EHR-launched 진입점).
// EHR이 ?iss=...&launch=... 로 호출하면 OAuth2 authorization 시작 → app.html로 redirect.
//
// 표준: SMART App Launch Framework v2.2.0
// 참조: https://hl7.org/fhir/smart-app-launch/
//
// 동적 client_id 매칭:
//   ?iss= 파라미터의 FHIR base URL 을 emrVendors 레지스트리와 비교 →
//   매칭된 vendor 의 client_id·scope 를 사용.
//   계약 진행 중(pending_contract) 또는 매칭 실패 시 SMART Sandbox 로 fallback.
import FHIR from 'fhirclient';
import { EMR_VENDORS, FALLBACK_VENDOR_KEY } from './config/emrVendors';

const params = new URLSearchParams(window.location.search);
const iss = (params.get('iss') || '').replace(/\/$/, '');

function findVendorByIss(issUrl) {
  if (!issUrl) return null;
  return Object.values(EMR_VENDORS).find(v =>
    issUrl.startsWith(v.fhirBase.replace(/\/$/, ''))
  ) || null;
}

const matched = findVendorByIss(iss);
const vendor = (matched && matched.status === 'active')
  ? matched
  : EMR_VENDORS[FALLBACK_VENDOR_KEY];

// eslint-disable-next-line no-console
console.info('[launch] iss:', iss || '(none)', '· vendor:', vendor.key,
  matched && matched.status !== 'active' ? '(fallback from pending_contract)' : '');

FHIR.oauth2.authorize({
  client_id:   vendor.clientId,
  scope:       vendor.scope,
  redirectUri: 'app.html',
});
