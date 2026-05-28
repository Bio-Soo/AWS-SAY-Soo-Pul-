/**
 * Rare-Link AI · Main Backend (FastAPI) REST 클라이언트.
 *
 * 백엔드 구조: api/app/routers/* (RareLink_AI_Architecture_Concepts_v1.docx §5.6)
 * dev: vite proxy 가 /api → http://localhost:8000 전달
 * production: CloudFront behavior 또는 별도 도메인 (api.rare-link.kr) 으로 라우팅
 *
 * 사용:
 *   import { backend } from '@/api/backend';
 *   const sess = await backend.sessions.create({ patient_fhir_id, symptom_text });
 *
 * 인증: SMART OAuth 토큰을 sessionStorage 에서 읽어 Authorization 헤더에 부착.
 *       토큰이 없으면 (DEV_BYPASS_AUTH=1 백엔드 모드 가정) 헤더 없이 호출.
 */

const BASE = '/api/v1';

function getToken() {
  try {
    return sessionStorage.getItem('SMART_ACCESS_TOKEN');
  } catch (_) {
    return null;
  }
}

async function request(method, path, { body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch (_) { detail = await res.text(); }
    const err = new Error(`${method} ${BASE}${path} → ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const backend = {
  // 진단 세션 (§5.6 sessions.py)
  sessions: {
    create:    (payload)             => request('POST', '/sessions', { body: payload }),
    run:       (id)                  => request('POST', `/sessions/${id}/run`),
    get:       (id, opts)            => request('GET',  `/sessions/${id}`, opts),
    result:    (id)                  => request('GET',  `/sessions/${id}/result`),
    rerun:     (id)                  => request('POST', `/sessions/${id}/rerun`),
  },
  // 환자 정보 (§5.6 patients.py)
  patients: {
    get:       (fhirId)              => request('GET',  `/patients/${encodeURIComponent(fhirId)}`),
    importOne: (fhirId)              => request('POST', '/patients/import',
                                                { body: { patient_fhir_id: fhirId } }),
  },
  // 의사 피드백 (§5.6 feedback.py)
  feedback: {
    create:    (payload)             => request('POST', '/feedback', { body: payload }),
  },
  // 워크리스트 (§5.6 admin.py · §6.4 daily preload)
  worklist: {
    list:      (date)                => request('GET',  `/worklist?date=${encodeURIComponent(date)}`),
    triggerPreload: (date)           => request('POST', `/admin/preload?date=${encodeURIComponent(date)}`),
  },
  // EMR Updates (보충)
  emrUpdates: {
    health:    ()                    => request('GET',  '/emr-updates/health'),
  },
  // 헬스
  health:      ()                    => fetch('/health').then(r => r.json()),
};

/**
 * 진단 세션 폴링 헬퍼 (§6.3 — Frontend 가 2초마다 폴링).
 * status 가 completed/failed/cancelled 가 되면 멈추고 resolve.
 */
export function pollSession(sessionId, {
  intervalMs = 2000,
  onTick,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const stop = () => { stopped = true; };
    if (signal) signal.addEventListener('abort', stop, { once: true });

    async function tick() {
      if (stopped) return;
      try {
        const s = await backend.sessions.get(sessionId);
        onTick && onTick(s);
        if (['completed', 'failed', 'cancelled'].includes(s.status)) {
          stop();
          resolve(s);
          return;
        }
      } catch (e) {
        stop();
        reject(e);
        return;
      }
      setTimeout(tick, intervalMs);
    }
    tick();
  });
}
