/**
 * Cognito 인증 — say2-2team-rare-link-pool 의사 로그인.
 *
 * 의사 계정은 self-signup 이 아니라 EMR 요청 기반으로 관리자가 생성한다
 * (User Pool 이 AllowAdminCreateUserOnly=true). 따라서 이 모듈은 로그인만
 * 담당하며 회원가입 함수는 두지 않는다.
 *
 * 의사 메타데이터(소속·면허·EMR 벤더)는 Cognito custom attributes 로 저장돼
 * ID 토큰 payload 에 실려 온다 → signIn() 이 doctor 객체로 변환한다.
 *
 * 환경변수:
 *   VITE_COGNITO_POOL_ID    — User Pool ID
 *   VITE_COGNITO_CLIENT_ID  — App Client ID (no secret, SPA)
 */

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';

const POOL_ID   = import.meta.env.VITE_COGNITO_POOL_ID;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
// Mock auth: when VITE_USE_MOCK !== 'false' AND no Cognito creds (e.g. GitHub Pages
// static demo), signIn() returns a fake doctor — any input is accepted.
const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

let _pool = null;
function getPool() {
  if (!POOL_ID || !CLIENT_ID) return null;
  if (!_pool) {
    _pool = new CognitoUserPool({ UserPoolId: POOL_ID, ClientId: CLIENT_ID });
  }
  return _pool;
}

/** Cognito 설정이 갖춰졌는지 (환경변수 누락 시 false). */
export function isCognitoConfigured() {
  return Boolean(getPool());
}

/**
 * ID 토큰 payload → 앱 내부 doctor 객체.
 * custom attributes 누락 시 빈 문자열로 graceful 처리.
 */
function payloadToDoctor(username, payload, idToken) {
  return {
    id:          username,
    name:        payload['name'] || username,
    role:        payload['custom:role'] || '',
    institution: payload['custom:institution'] || '',
    department:  payload['custom:department'] || '',
    licenseNo:   payload['custom:license_no'] || '',
    emrVendor:   payload['custom:emr_vendor'] || 'smart_sandbox',
    email:       payload['email'] || '',
    // 당일 외래 환자 데이터 일괄 수신 시각 (의사별, HH:MM) — 기본 08:00
    worklistTime: payload['custom:worklist_time'] || '08:00',
    idToken,
  };
}

/**
 * 외래 데이터 수신 시각을 Cognito custom attribute 에 저장 (의사 계정에 귀속).
 * @param {string} time  'HH:MM'
 * @returns {Promise<void>}
 */
export function saveWorklistTime(time) {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const user = pool && pool.getCurrentUser();
    if (!user) { reject(new Error('로그인 세션이 없습니다.')); return; }
    user.getSession((err) => {
      if (err) { reject(err); return; }
      user.updateAttributes(
        [{ Name: 'custom:worklist_time', Value: String(time) }],
        (e) => e ? reject(e) : resolve(),
      );
    });
  });
}

/**
 * 의사 ID + 비밀번호로 Cognito 로그인.
 * @returns {Promise<object>}  성공 시 doctor 객체, 실패 시 reject(Error)
 */
export function signIn(doctorId, password) {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    if (!pool) {
      // Mock mode fallback (GitHub Pages demo / dev without Cognito).
      if (USE_MOCK) {
        const username = (doctorId || 'demo').trim() || 'demo';
        resolve({
          id:           username,
          name:         username === 'demo' ? '시연 의사' : username,
          role:         '호흡기내과 전문의',
          institution:  'Soo-Pul 데모',
          department:   '호흡기내과',
          licenseNo:    'DEMO-000000',
          emrVendor:    'smart_sandbox',
          email:        `${username}@demo.local`,
          worklistTime: '08:00',
          idToken:      'mock-id-token',
        });
        return;
      }
      reject(new Error('인증 설정이 누락되었습니다. 관리자에게 문의하세요.'));
      return;
    }
    const username = (doctorId || '').trim();
    const user = new CognitoUser({ Username: username, Pool: pool });
    const authDetails = new AuthenticationDetails({
      Username: username,
      Password: password,
    });
    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        const idToken = session.getIdToken();
        resolve(payloadToDoctor(username, idToken.decodePayload(), idToken.getJwtToken()));
      },
      onFailure: (err) => {
        // Cognito 오류 코드 → 사용자 메시지
        const code = err && err.code;
        if (code === 'NotAuthorizedException' || code === 'UserNotFoundException') {
          reject(new Error('의사 ID 또는 비밀번호가 일치하지 않습니다.'));
        } else if (code === 'UserNotConfirmedException') {
          reject(new Error('계정이 아직 활성화되지 않았습니다. 관리자에게 문의하세요.'));
        } else if (code === 'PasswordResetRequiredException') {
          reject(new Error('비밀번호 재설정이 필요합니다. 관리자에게 문의하세요.'));
        } else {
          reject(new Error((err && err.message) || '로그인 중 오류가 발생했습니다.'));
        }
      },
      newPasswordRequired: () => {
        reject(new Error('초기 비밀번호 변경이 필요합니다. 관리자에게 문의하세요.'));
      },
    });
  });
}

/** 현재 Cognito 세션 로그아웃 (있을 경우). */
export function signOutCognito() {
  const pool = getPool();
  const user = pool && pool.getCurrentUser();
  if (user) {
    try { user.signOut(); } catch (_) { /* noop */ }
  }
}
