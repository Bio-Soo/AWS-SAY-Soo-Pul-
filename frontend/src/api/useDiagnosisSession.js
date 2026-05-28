/**
 * useDiagnosisSession — 진단 세션 lifecycle 을 한 줄로 다루는 React hook.
 *
 * Flow (RareLink_AI_Architecture_Concepts §6.3):
 *   1. POST /sessions              — 세션 생성
 *   2. POST /sessions/{id}/run      — Step Functions 트리거
 *   3. GET  /sessions/{id} (2s 폴링) — phase1~5 진행 상태 + 결과
 *   4. GET  /sessions/{id}/result   — 완료 시 final RAG 리포트
 *
 * Mock mode (VITE_USE_MOCK=1):
 *   네트워크 호출 없이 setTimeout 으로 phase 진행 시뮬레이션. backend 미배포 환경 + 발표 fallback 용.
 *
 * 사용:
 *   const dx = useDiagnosisSession();
 *   dx.start({ patient_fhir_id: '20-145982', symptom_text: '...', cxr_s3_key: 's3://...' });
 *   // dx.phases.phase1 === 'pending' | 'running' | 'succeeded' | 'failed'
 *   // dx.session       === SessionDetailResponse (gets updated each tick)
 *   // dx.result        === SessionFinalReport (after completed)
 *   // dx.error         === Error | null
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { backend, pollSession } from './backend';

const PHASE_KEYS = ['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'final'];
const POLL_INTERVAL_MS = 2000;
// VITE_USE_MOCK=true 는 SMART OAuth/FHIR mock 모드 (LoginWorklist 의 launcher 우회)와 공유되는 flag.
// 그러나 진단 (sessions API) 은 VITE_USE_BACKEND_SESSIONS=1 이면 항상 backend 호출 — 두 flag 분리.
const USE_BACKEND_SESSIONS = (import.meta.env.VITE_USE_BACKEND_SESSIONS || '0') === '1';
const USE_MOCK = !USE_BACKEND_SESSIONS
              && (import.meta.env.VITE_USE_MOCK || '0') === '1';

function emptyPhases() {
  return Object.fromEntries(PHASE_KEYS.map(k => [k, 'pending']));
}

/**
 * Backend SessionDetailResponse 의 phase1~5 + status 를 보고
 * PHASE_KEYS 별 'pending|running|succeeded|failed' 로 환원.
 */
function phasesFromSession(s) {
  if (!s) return emptyPhases();
  const out = emptyPhases();
  for (const k of ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']) {
    if (s[k]) {
      out[k] = 'succeeded';
    } else if (s.status === 'failed') {
      // 어디서 실패한지 모르면 마지막으로 succeed 안 한 첫 phase 가 failed 후보
      // (백엔드가 current_phase 를 채워주면 거기에 맞춰 수정)
      out[k] = 'failed';
      break;
    } else if (s.status === 'running') {
      // 아직 도착 안 한 첫 phase = running, 나머지 = pending
      out[k] = 'running';
      break;
    }
  }
  if (s.status === 'completed') {
    out.final = 'succeeded';
  } else if (s.status === 'failed') {
    out.final = 'failed';
  } else if (s.status === 'running' && s.phase5) {
    out.final = 'running';
  }
  return out;
}

export function useDiagnosisSession() {
  const [sessionId, setSessionId]   = useState(null);
  const [status, setStatus]         = useState('idle');   // idle | starting | running | completed | failed
  const [phases, setPhases]         = useState(emptyPhases());
  const [session, setSession]       = useState(null);     // SessionDetailResponse
  const [result, setResult]         = useState(null);     // SessionFinalReport
  const [error, setError]           = useState(null);

  const abortRef = useRef(null);
  const mockTimersRef = useRef([]);
  // 실행 세대(generation) — start/rerun 이 호출될 때마다 증가.
  // 오래된 폴링 루프의 onTick 이 state 를 덮어쓰지 못하게 막는 가드
  // (중복 start 시 폴링 루프가 2개 생겨 phase 결과가 깜빡이던 버그 방지).
  const runIdRef = useRef(0);

  const cleanup = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    mockTimersRef.current.forEach(t => clearTimeout(t));
    mockTimersRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async (payload) => {
    cleanup();
    const myRun = ++runIdRef.current;        // 이 호출의 세대 번호
    const isStale = () => runIdRef.current !== myRun;
    setStatus('starting');
    setPhases(emptyPhases());
    setSession(null);
    setResult(null);
    setError(null);

    if (USE_MOCK) {
      _runMock({ setPhases, setStatus, setResult, mockTimersRef, payload });
      return;
    }

    try {
      const created = await backend.sessions.create(payload);
      if (isStale()) return;                 // 더 최신 start/rerun 이 시작됨 → 폐기
      setSessionId(created.session_id);
      await backend.sessions.run(created.session_id);
      if (isStale()) return;
      setStatus('running');

      const ac = new AbortController();
      abortRef.current = ac;
      const finalSess = await pollSession(created.session_id, {
        intervalMs: POLL_INTERVAL_MS,
        signal: ac.signal,
        onTick: (s) => {
          if (isStale()) return;             // 오래된 폴링 → state 덮어쓰기 금지
          setSession(s);
          setPhases(phasesFromSession(s));
        },
      });
      if (isStale()) return;
      setSession(finalSess);
      setPhases(phasesFromSession(finalSess));

      if (finalSess.status === 'completed') {
        const r = await backend.sessions.result(created.session_id);
        if (isStale()) return;
        setResult(r);
        setStatus('completed');
      } else {
        setStatus('failed');
        setError(new Error(`Pipeline status=${finalSess.status}`));
      }
    } catch (e) {
      if (isStale()) return;
      setStatus('failed');
      setError(e);
    }
  }, [cleanup]);

  const rerun = useCallback(async () => {
    if (!sessionId) return;
    cleanup();
    const myRun = ++runIdRef.current;
    const isStale = () => runIdRef.current !== myRun;
    setStatus('starting');
    setPhases(emptyPhases());
    setSession(null);
    setResult(null);
    setError(null);

    try {
      const created = await backend.sessions.rerun(sessionId);
      if (isStale()) return;
      setSessionId(created.session_id);
      await backend.sessions.run(created.session_id);
      if (isStale()) return;
      setStatus('running');
      const ac = new AbortController();
      abortRef.current = ac;
      const finalSess = await pollSession(created.session_id, {
        intervalMs: POLL_INTERVAL_MS,
        signal: ac.signal,
        onTick: (s) => {
          if (isStale()) return;
          setSession(s);
          setPhases(phasesFromSession(s));
        },
      });
      if (isStale()) return;
      setSession(finalSess);
      setPhases(phasesFromSession(finalSess));
      if (finalSess.status === 'completed') {
        const r = await backend.sessions.result(created.session_id);
        if (isStale()) return;
        setResult(r);
        setStatus('completed');
      } else {
        setStatus('failed');
      }
    } catch (e) {
      if (isStale()) return;
      setStatus('failed');
      setError(e);
    }
  }, [sessionId, cleanup]);

  const stop = useCallback(() => {
    cleanup();
    runIdRef.current++;          // 진행 중 폴링의 onTick 무효화
    setStatus('idle');
  }, [cleanup]);

  return { start, rerun, stop, status, phases, session, result, error, sessionId, isMock: USE_MOCK };
}

/* ---------- Mock simulator ---------- */
function _runMock({ setPhases, setStatus, setResult, mockTimersRef, payload }) {
  const schedule = [
    [600,  { phase1: 'running' }],
    [1800, { phase1: 'succeeded', phase2: 'running' }],
    [3200, { phase1: 'succeeded', phase2: 'succeeded', phase3: 'running' }],
    [4800, { phase3: 'succeeded', phase4: 'running' }],
    [6200, { phase4: 'succeeded', phase5: 'running' }],
    [7800, { phase5: 'succeeded', final: 'running' }],
    [9400, { final: 'succeeded' }],
  ];
  setStatus('running');
  const start = emptyPhases();
  for (const [ms, delta] of schedule) {
    mockTimersRef.current.push(setTimeout(() => {
      setPhases(prev => ({ ...start, ...prev, ...delta }));
    }, ms));
  }
  mockTimersRef.current.push(setTimeout(() => {
    setStatus('completed');
    setResult({
      session_id: 'mock-' + Date.now(),
      patient_fhir_id: payload?.patient_fhir_id || 'mock',
      final_dx: '특발성 폐섬유증 (IPF)',
      confidence: 'HIGH',
      diagnosis_json: { final_dx: '특발성 폐섬유증 (IPF)', confidence: 'HIGH' },
      markdown_report: '# Mock report\n\n(VITE_USE_MOCK=1)',
      full_report_md: '# Mock report\n\n(VITE_USE_MOCK=1)',
      rag_citations: [],
      rag_apis_used: ['PubMed', 'Orphanet'],
      self_check: { pmid_total: 0, pmid_valid: 0, pmid_rate: 1.0 },
      llm_model: 'mock',
      s3_uri_pdf: null,
      generated_at: new Date().toISOString(),
    });
  }, 9800));
}
