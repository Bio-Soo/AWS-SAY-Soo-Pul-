/**
 * Session — sessionStorage 기반 1시간 TTL 의사 세션.
 *
 * 데모 단계의 mock 인증입니다. 발표 후 AWS Cognito User Pool 로 swap 예정.
 * - 운영 환경에선 Cognito ID/Access Token 이 동일 인터페이스로 대체.
 * - sessionStorage 사용은 CLAUDE.md §3 의 `SMART_AUTHORIZED` 예외와 같은 정책.
 *
 * 환경변수:
 *   VITE_SESSION_TIMEOUT_MIN  — 세션 TTL (분). 기본 60. 운영자 조정 가능.
 *
 * 저장 형식:
 *   {
 *     doctor:     { id, name, role, institution, department,
 *                   licenseNo, emrVendor, ... },
 *     issuedAt:   epoch ms,
 *     expiresAt:  epoch ms,
 *     ttlMin:     number  (감사용)
 *   }
 *
 * ⚠️ 환자 식별정보·진료기록은 절대 세션에 저장 금지 (개인정보보호법·HIPAA).
 *    SMART 토큰은 fhirclient.js 가 별도 sessionStorage 키로 관리.
 */

export const SESSION_KEY = 'rl-session';

const DEFAULT_TTL_MIN = 60;

function getTtlMs() {
  const raw = Number(import.meta.env?.VITE_SESSION_TIMEOUT_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MIN;
  return min * 60 * 1000;
}

export function getSessionTtlMin() {
  const raw = Number(import.meta.env?.VITE_SESSION_TIMEOUT_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MIN;
}

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return { doctor: null, expired: false };
    const s = JSON.parse(raw);
    if (!s.expiresAt || Date.now() > s.expiresAt) {
      sessionStorage.removeItem(SESSION_KEY);
      return { doctor: null, expired: true };
    }
    return { doctor: s.doctor, expired: false, expiresAt: s.expiresAt };
  } catch {
    return { doctor: null, expired: false };
  }
}

export function saveSession(doctor) {
  const ttlMs = getTtlMs();
  const now = Date.now();
  const s = {
    doctor,
    issuedAt:  now,
    expiresAt: now + ttlMs,
    ttlMin:    Math.round(ttlMs / 60000),
  };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  return s;
}

export function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export function renewSession() {
  const s = loadSession();
  if (!s.doctor) return false;
  saveSession(s.doctor);
  return true;
}
