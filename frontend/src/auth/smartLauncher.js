/**
 * SMART Launcher — 의사 로그인 직후 SMART on FHIR Standalone Launch 자동 발동.
 *
 * 두 진입점 구분:
 *   - EHR-launched (외부 EMR 에서 ?iss=&launch= 호출) → `public/launch.html` + `src/launch.js`
 *   - Standalone   (의사가 우리 사이트 직접 접속 → Cognito mock 로그인)  → ★ 이 파일
 *
 * Mock 토글:
 *   VITE_USE_MOCK=true  → SMART 발동 안 함 (mock 환자 데이터로 진행, 데모 흐름 보전)
 *   VITE_USE_MOCK=false → fhirclient 의 SMART.oauth2.authorize() 호출 (실서버 결선)
 *
 * 표준: SMART App Launch Framework v2.2.0 §5.1 Standalone Launch
 *       https://hl7.org/fhir/smart-app-launch/app-launch.html#standalone-launch
 */

import FHIR from 'fhirclient';
import { resolveVendor } from '../config/emrVendors';

const USE_MOCK = String(import.meta.env?.VITE_USE_MOCK ?? 'true').toLowerCase() !== 'false';

/**
 * 의사 객체에서 emrVendor 를 읽어 standalone SMART OAuth 시작.
 *
 * @param {object} doctor  saveSession 으로 저장된 의사 객체
 * @returns {{ launched: boolean, vendorKey: string, didFallback: boolean, reason?: string }}
 *
 * 호출자(LoginWorklist onLogin 핸들러)는 launched=true 면 페이지가 곧
 * SMART authorization endpoint 로 redirect 됨을 가정해야 함 (React state 의미 없음).
 */
export function launchSmartForDoctor(doctor) {
  if (!doctor || !doctor.emrVendor) {
    return { launched: false, vendorKey: 'none', didFallback: false, reason: 'no-emr-vendor' };
  }

  if (USE_MOCK) {
    // 데모 모드 — 실제 OAuth 발동 없이 로그만 남기고 통과.
    // 사용자 시연 흐름이 SMART 리다이렉트로 끊기지 않도록 함.
    // eslint-disable-next-line no-console
    console.info(
      '[smartLauncher] VITE_USE_MOCK=true — SMART 발동 생략. ',
      'doctor:', doctor.doctorId, '· emrVendor:', doctor.emrVendor,
    );
    return { launched: false, vendorKey: doctor.emrVendor, didFallback: false, reason: 'mock-mode' };
  }

  const { vendor, didFallback } = resolveVendor(doctor.emrVendor);

  if (didFallback) {
    // eslint-disable-next-line no-console
    console.warn(
      `[smartLauncher] vendor "${doctor.emrVendor}" 는 계약 진행 중 — `,
      `sandbox(${vendor.key}) 로 fallback`,
    );
  }

  FHIR.oauth2.authorize({
    iss:         vendor.fhirBase,
    clientId:    vendor.clientId,
    scope:       vendor.scope,
    redirectUri: 'app.html',
  });

  return { launched: true, vendorKey: vendor.key, didFallback };
}
