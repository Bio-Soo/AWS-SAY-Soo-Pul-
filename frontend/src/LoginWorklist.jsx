import React, { useState, useEffect, useRef, useLayoutEffect, useContext, useCallback } from 'react';
import { Stethoscope, LogIn, LogOut, User, UserPlus, Calendar, AlertTriangle, Flame, Activity, Microscope, Clock, CheckCircle2, CircleDot, Circle, Search, Filter, Bell, ChevronRight, ChevronLeft, Shield, Zap, X, ScanLine, FileText, ArrowUpRight, ListFilter, MoreHorizontal, Loader2, Inbox, Users, CalendarDays, Eye, ChevronDown, ChevronUp, Home, Ban, FlaskConical, Settings as SettingsIcon, BookOpen, BarChart3, Languages, Database, KeyRound, HelpCircle, Mail, Volume2, Sliders, Palette, RefreshCw, Megaphone } from 'lucide-react';
import { isSmartAuthorized, canFetchFhir, getClient, fetchPatients, pingFhir } from './api/fhirAdapter';
import { loadSession, saveSession, clearSession, renewSession, getSessionTtlMin } from './auth/session';
import { signIn as cognitoSignIn, signOutCognito, saveWorklistTime } from './auth/cognito';
import { launchSmartForDoctor } from './auth/smartLauncher';
import AnalyticsDashboard from './AnalyticsDashboard';
import RareLinkDesignSystem from './DesignSystem.jsx';
import { connectEmrUpdates } from './api/emrUpdates';
import { backend } from './api/backend';
import { useDiagnosisSession } from './api/useDiagnosisSession';
import Phase5LRBars from './components/Phase5LRBars';

// VITE_USE_BACKEND_SESSIONS=1 이면 PatientChart 의 phase 진행이
// backend (FastAPI + Step Functions) 응답을 따름. 기본은 mock 시뮬레이션.
const USE_BACKEND_SESSIONS = (import.meta.env.VITE_USE_BACKEND_SESSIONS || '0') === '1';

/* ============================================================
   BILINGUAL (KO/EN) RENDERING HELPERS
   외국인 환자(예: "John Müller", "O'Brien")의 영문 이름·주호소·진단명이
   Plex KR의 CJK-tuned Latin 글리프로 렌더되지 않도록 lang/className을 자동 부착.
   ============================================================ */
const HAS_HANGUL = /[ㄱ-ㆎ가-힣]/;
const HAS_LATIN  = /[A-Za-z]/;

// Latin 비중이 절반 이상이고 한글이 없으면 "영문 텍스트"로 간주
function isMostlyLatin(s) {
  if (!s || typeof s !== 'string') return false;
  if (HAS_HANGUL.test(s)) return false;
  return HAS_LATIN.test(s);
}

/**
 * <BiText>{patient.name}</BiText>
 * - 한글 → 그대로 렌더 (lang 미부착)
 * - 영문 → lang="en" + .t-en (Plex Latin + tight letter-spacing)
 * - serif prop=true → Banner 등 Plex Serif 영역에서도 동일 동작
 */
function BiText({ children, as = 'span', serif = false, className = '', style }) {
  const Tag = as;
  const text = typeof children === 'string' ? children : '';
  const latin = isMostlyLatin(text);
  const cls = [
    className,
    latin ? (serif ? 't-en-serif' : 't-en') : '',
  ].filter(Boolean).join(' ');
  return (
    <Tag
      {...(latin ? { lang: 'en' } : {})}
      className={cls || undefined}
      style={style}
    >
      {children}
    </Tag>
  );
}

/* ============================================================
   DATETIME · 항상 YYYY-MM-DD HH:mm:ss 까지 표시 (mock 은 KST 가정)
   ============================================================ */
function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDateTime(input) {
  if (input == null || input === '') return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtDateOnly(input) {
  if (input == null || input === '') return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTimeOnly(input) {
  if (input == null || input === '') return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ============================================================
   AutoFitText · 컨테이너 너비 초과 시 폰트 자동 축소.
   부모가 width 를 제약한 상태여야 동작. 한 줄 텍스트 전제.
   ============================================================ */
function AutoFitText({
  children,
  max = 12,
  min = 8,
  step = 0.5,
  className = '',
  style = {},
  as = 'span',
}) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      let s = max;
      el.style.fontSize = `${s}px`;
      let guard = 80;
      while (s > min && el.scrollWidth > el.clientWidth + 0.5 && guard-- > 0) {
        s -= step;
        el.style.fontSize = `${s}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  });
  const Tag = as;
  return (
    <Tag
      ref={ref}
      className={className}
      style={{
        display: 'block',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/* ============================================================
   EMR Updates Context · WebSocket 으로 받는 pendingByMrn
   - 백엔드 (api/app/routers/emr_updates.py) 가 push 하는 emr-update 메시지를
     앱 전체에서 수신해 환자별 pending 카운트로 누적.
   - PatientChart 가 useEmrPending(mrn) 으로 읽어서 EmrUpdateButton 배지에 반영.
   - 사용자가 「정보 업데이트」 클릭으로 처리 완료 시 consume(mrn) 으로 클리어.
   ============================================================ */
const EmrPendingContext = React.createContext({
  pendingByMrn: {},
  wsState: 'closed',
  consume: () => {},
});

function EmrPendingProvider({ children }) {
  const [pendingByMrn, setPendingByMrn] = useState({});
  const [wsState, setWsState] = useState('closed');

  useEffect(() => {
    const conn = connectEmrUpdates({
      onMessage: (msg) => {
        if (msg && msg.type === 'emr-update' && msg.mrn) {
          const delta = Number(msg.pendingDelta || 1);
          setPendingByMrn((prev) => ({
            ...prev,
            [msg.mrn]: (prev[msg.mrn] || 0) + delta,
          }));
        }
      },
      onHello: (h) => {
        // dev 가시성용 — 프로덕션에서 noisy 하면 제거
        console.info('[EmrWS] hello', h);
      },
      onState: setWsState,
    });
    return () => conn.close();
  }, []);

  const consume = useCallback((mrn) => {
    if (!mrn) return;
    setPendingByMrn((prev) => {
      if (!prev[mrn]) return prev;
      const { [mrn]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  return (
    <EmrPendingContext.Provider value={{ pendingByMrn, wsState, consume }}>
      {children}
    </EmrPendingContext.Provider>
  );
}

function useEmrPending(mrn) {
  const ctx = useContext(EmrPendingContext);
  return {
    pending: mrn ? (ctx.pendingByMrn[mrn] || 0) : 0,
    wsState: ctx.wsState,
    consume: () => ctx.consume(mrn),
  };
}

/* ----- TOPBAR · 알림 (Bell + dropdown) ----- */
const MOCK_NOTIFICATIONS = [
  // 외래 추가 등록
  { type: 'admit', date: '2026-04-23', time: '08:55', title: '신규 외래 등록', text: '원○○ · 22 F · 14:00 슬롯 (재진)',          category: 'admit', patientMrn: '23-145220',
    detail: { patient: '원○○ (23-145220)', source: '현장 접수', slot: '14:00 재진', complaint: '과호흡 · 두근거림 · 시험 기간 스트레스', referrer: 'walk-in' } },
  { type: 'admit', date: '2026-04-23', time: '08:42', title: '응급 콜인',       text: '서○○ · 56 M · 응급실 → 호흡기내과 의뢰',  category: 'admit', patientMrn: '24-002188',
    detail: { patient: '서○○ (24-002188)', source: '응급실 의뢰', slot: '11:30 추가', complaint: '급성 호흡곤란 · SpO₂ 88%', referrer: '응급의학과 김재현 전공의' } },

  // 결과 도착 (CXR / AI / Lab 각 항목)
  { type: 'cxr', date: '2026-04-23', time: '09:02', title: 'CXR 도착', text: '정○○ · LAM workup · Frontal',           category: 'result', patientMrn: '22-089433',
    detail: { patient: '정○○ (22-089433)', modality: 'CR Frontal', studyId: 'STU-2026-0423-0042', size: '448×448 (resized)', technician: '영상의학과' } },
  { type: 'ai',  date: '2026-04-23', time: '08:58', title: 'AI 분석 완료', text: '정○○ · LAM 58% · 희귀 의심',         category: 'result', patientMrn: '22-089433',
    detail: { patient: '정○○ (22-089433)', model: 'DenseNet-121 v2.3.1', latencyMs: 642, top: 'LAM 58% · PLCH 31% · idiopathic 18%', flags: '희귀' } },
  { type: 'lab', date: '2026-04-23', time: '08:48', title: 'Lab 결과 도착', text: '이○○ · CRP 0.8 (high) · CBC 정상', category: 'result', patientMrn: '21-093127',
    detail: { patient: '이○○ (21-093127)', drawnAt: '07:55', panels: 'CBC · Chem · Inflammation', abnormal: 'CRP 0.8 (↑) · ESR 38 (↑)', remark: 'Pneumonia 패턴 합치' } },
  { type: 'ai',  date: '2026-04-23', time: '08:21', title: 'AI 분석 완료', text: "김○○ · IPF 84% · Don't miss 플래그", category: 'result', patientMrn: '20-145982',
    detail: { patient: '김○○ (20-145982)', model: 'DenseNet-121 v2.3.1', latencyMs: 718, top: 'IPF 84% · Sarcoidosis 62% · HP 41%', flags: "Don't miss · 희귀 (ORPHA:2032)" } },
  { type: 'lab', date: '2026-04-23', time: '07:55', title: 'Lab 결과 도착', text: '장○○ · KL-6 1284 (critical)',      category: 'result', patientMrn: '22-145103',
    detail: { patient: '장○○ (22-145103)', drawnAt: '07:12', panels: 'CBC · Chem · ABG · Markers', abnormal: 'KL-6 1284 (↑↑) · SP-D 178 (↑) · RF 14', remark: 'RA-ILD 패턴 강력 시사' } },
  { type: 'cxr', date: '2026-04-23', time: '07:42', title: 'CXR 도착', text: '김○○ · IPF workup · Frontal',           category: 'result', patientMrn: '20-145982',
    detail: { patient: '김○○ (20-145982)', modality: 'CR Frontal', studyId: 'STU-2026-0423-0021', size: '448×448 (resized)', technician: '영상의학과' } },

  // 시스템
  { type: 'sys', date: '2026-04-23', time: '07:00', title: '모델 업데이트 배포', text: 'DenseNet-121 v2.3.1 (재학습 2026-03-15)',  category: 'system',
    detail: { component: 'DenseNet-121 SageMaker endpoint', version: 'v2.3.1', changes: '재학습 (NIH ChestX-ray14 + MIMIC-CXR-JPG · 2026-03-15) · 미세 분류 정확도 +1.8%', deployedBy: '배기태 · 허태웅' } },
  { type: 'sys', date: '2026-04-23', time: '06:30', title: 'HPO DB 갱신',         text: '2026-03-01 release · 12,847 terms',         category: 'system',
    detail: { component: 'HPO Knowledge Base', version: '2026-03-01', changes: '신규 term 142개 · 매핑 변경 38개', deployedBy: '권미라 · 양희인' } },
  { type: 'sys', date: '2026-04-23', time: '06:00', title: 'FHIR 정기 점검 완료', text: 'SMART Health IT sandbox 06:00–06:15',       category: 'system',
    detail: { component: 'SMART on FHIR sandbox', version: 'v2.2', changes: '정기 점검 · 다운타임 15분', deployedBy: 'AWS infra' } },
];

/* 전체 알림 히스토리 · 어제 ~ 며칠 전 (popup용) */
const MOCK_NOTIFICATION_HISTORY = [
  ...MOCK_NOTIFICATIONS,

  // 2026-04-22
  { type: 'admit', date: '2026-04-22', time: '13:48', title: '신규 외래 등록', text: '강○○ · 73 M · 14:00 슬롯 (재진)', category: 'admit', patientMrn: '15-228714',
    detail: { patient: '강○○ (15-228714)', source: '예약', slot: '14:00 재진', complaint: '만성 호흡곤란 · 흡연력 50 pack-year', referrer: '본인 예약' } },
  { type: 'ai',  date: '2026-04-22', time: '13:48', title: 'AI 분석 완료', text: '강○○ · COPD GOLD III 79%', category: 'result', patientMrn: '15-228714',
    detail: { patient: '강○○ (15-228714)', model: 'DenseNet-121 v2.3.1', latencyMs: 691, top: 'COPD III 79% · Bronchiectasis 34%', flags: '없음' } },
  { type: 'lab', date: '2026-04-22', time: '13:14', title: 'Lab 결과 도착', text: '강○○ · ABG 정상 · CRP 정상', category: 'result', patientMrn: '15-228714',
    detail: { patient: '강○○ (15-228714)', drawnAt: '12:48', panels: 'CBC · Chem · ABG', abnormal: '없음', remark: 'GOLD III 안정기' } },
  { type: 'sys', date: '2026-04-22', time: '11:00', title: '운영 공지',       text: '내일(04-23) 06:00–06:15 FHIR sandbox 점검 예정', category: 'system',
    detail: { component: 'FHIR sandbox', version: '—', changes: '정기 유지 보수 안내', deployedBy: 'AWS infra' } },

  // 2026-04-21
  { type: 'admit', date: '2026-04-21', time: '08:30', title: '신규 외래 등록', text: '문○○ · 38 F · 10:30 슬롯 (재진)', category: 'admit', patientMrn: '20-118245',
    detail: { patient: '문○○ (20-118245)', source: '예약', slot: '10:30 재진', complaint: '활동 시 호흡곤란 · ground-glass FU', referrer: '본인 예약' } },
  { type: 'ai',  date: '2026-04-21', time: '10:12', title: 'AI 분석 완료', text: '문○○ · NSIP 66% · 희귀', category: 'result', patientMrn: '20-118245',
    detail: { patient: '문○○ (20-118245)', model: 'DenseNet-121 v2.3.1', latencyMs: 705, top: 'NSIP 66% · HP 39%', flags: '희귀 (ORPHA:79126)' } },
  { type: 'sys', date: '2026-04-21', time: '17:30', title: 'UI 업데이트',     text: 'Worklist 사이드바 리사이즈 기능 추가', category: 'system',
    detail: { component: 'Frontend', version: 'v0.1.0-rc2', changes: '환자 목록 사이드바 200~320px 드래그 리사이즈', deployedBy: '박성수' } },

  // 2026-04-20
  { type: 'sys', date: '2026-04-20', time: '09:00', title: '버전 배포',       text: 'v0.1.0 alpha · 디자인 시스템 · 로그인 · 워크리스트', category: 'system',
    detail: { component: 'Soo-Pul Frontend', version: 'v0.1.0-alpha', changes: 'Final Phase Week 1 시작 · 디자인 시스템 + 로그인 + 워크리스트 화면', deployedBy: '박성수' } },
  { type: 'admit', date: '2026-04-20', time: '14:00', title: '신규 외래 등록', text: '백○○ · 64 M · 13:30 슬롯', category: 'admit', patientMrn: '22-145210',
    detail: { patient: '백○○ (22-145210)', source: '예약', slot: '13:30 초진', complaint: '체중감소 · 객혈 · 림프절 종대', referrer: '1차의원 의뢰' } },

  // 2026-04-19
  { type: 'sys', date: '2026-04-19', time: '20:00', title: 'KB 갱신',         text: 'Orphadata 2026-Q1 (9,872 dx)', category: 'system',
    detail: { component: 'Orphadata KB', version: '2026-Q1', changes: '신규 희귀질환 코드 247건', deployedBy: '권미라 · 양희인' } },
  { type: 'sys', date: '2026-04-19', time: '15:00', title: '모델 평가 완료',  text: 'DenseNet-121 v2.3.1 ROC-AUC 0.92 (외부 검증)', category: 'system',
    detail: { component: 'Model evaluation', version: 'v2.3.1', changes: 'MIMIC-CXR-JPG 외부 검증 ROC-AUC 0.92 (CI 0.90-0.94)', deployedBy: '배기태' } },
];

function NotificationButton({ onOpenPatient, onOpenAnnouncement }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const total = MOCK_NOTIFICATIONS.length;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-1.5 rounded transition hover:bg-slate-100"
        style={{ color: open ? 'var(--rl-primary)' : 'var(--rl-ink-2)' }}
        title={`알림 ${total}건`}
      >
        <Bell size={16} />
        {total > 0 && (
          <div
            className="absolute top-0 right-0 rounded-full font-mono flex items-center justify-center"
            style={{
              minWidth: 14, height: 14, padding: '0 3px',
              background: 'var(--rl-critical)', color: 'white',
              fontSize: 9, fontWeight: 600,
            }}
          >
            {total}
          </div>
        )}
      </button>
      {open && <NotificationPanel onClose={() => setOpen(false)} onOpenPatient={onOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />}
    </div>
  );
}

function NotificationPanel({ onClose, onOpenPatient, onOpenAnnouncement }) {
  const grouped = {
    admit:  MOCK_NOTIFICATIONS.filter(n => n.category === 'admit'),
    result: MOCK_NOTIFICATIONS.filter(n => n.category === 'result'),
    system: MOCK_NOTIFICATIONS.filter(n => n.category === 'system'),
  };
  const total = MOCK_NOTIFICATIONS.length;

  const handleClick = (n) => {
    if (n.category === 'system') {
      if (onOpenAnnouncement) onOpenAnnouncement(n);
      else openSystemAnnouncementPopup(n); // fallback
    } else if (n.patientMrn && onOpenPatient) {
      onOpenPatient(n.patientMrn);
    }
    onClose();
  };

  return (
    <div
      className="absolute bg-white rounded fade-in"
      style={{
        top: 38, right: 0, width: 360,
        maxHeight: 380,
        boxShadow: '0 12px 36px rgba(10,22,40,0.18)',
        border: '1px solid var(--rl-border)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
      }}
    >
      {/* Header */}
      <div className="px-4 py-2.5 flex items-center" style={{ borderBottom: '1px solid var(--rl-border-soft)', flexShrink: 0 }}>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          Notifications
        </div>
        <div className="text-sm font-medium ml-2" style={{ color: 'var(--rl-ink)' }}>알림</div>
        <span className="ml-auto font-mono text-[10px]" style={{ color: 'var(--rl-amber)' }}>{total}건</span>
      </div>

      {/* Scrollable body · sticky group headers · 4-5 rows visible */}
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <NotifGroup label="외래 추가 등록" mono="Admit"  items={grouped.admit}  onClick={handleClick} />
        <NotifGroup label="결과 도착"      mono="Result" items={grouped.result} onClick={handleClick} />
        <NotifGroup label="시스템"          mono="System" items={grouped.system} onClick={handleClick} />
      </div>

      {/* Footer */}
      <div className="px-3 py-2 flex items-center gap-3" style={{ borderTop: '1px solid var(--rl-border-soft)', flexShrink: 0 }}>
        <button
          className="font-mono text-[10px] uppercase tracking-widest hover:underline"
          style={{ color: 'var(--rl-primary)' }}
        >
          모두 읽음 처리
        </button>
        <button
          onClick={() => { openNotificationHistoryPopup(); onClose(); }}
          className="font-mono text-[10px] uppercase tracking-widest hover:underline flex items-center gap-1"
          style={{ color: 'var(--rl-ink-2)' }}
          title="전체 알림 히스토리 새 창"
        >
          <Clock size={10} /> 히스토리
        </button>
        <button
          onClick={onClose}
          className="ml-auto font-mono text-[10px] uppercase tracking-widest hover:underline"
          style={{ color: 'var(--rl-ink-3)' }}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

function NotifGroup({ label, mono, items, onClick }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div
        className="px-4 py-1.5 flex items-baseline gap-2"
        style={{
          background: 'var(--rl-bg-3)',
          borderBottom: '1px solid var(--rl-border-soft)',
          position: 'sticky', top: 0, zIndex: 1,
        }}
      >
        <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>{mono}</span>
        <span className="text-[11px] font-medium" style={{ color: 'var(--rl-ink-2)' }}>{label}</span>
        <span className="ml-auto font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{items.length}건</span>
      </div>
      {items.map((n, i) => <NotifRow key={i} n={n} onClick={() => onClick && onClick(n)} />)}
    </div>
  );
}

const NOTIF_ICON = {
  admit: { icon: UserPlus,     color: 'var(--rl-primary)' },
  cxr:   { icon: ScanLine,     color: 'var(--rl-teal)' },
  ai:    { icon: Microscope,   color: 'var(--rl-amber)' },
  lab:   { icon: FlaskConical, color: 'var(--rl-teal)' },
  sys:   { icon: SettingsIcon, color: 'var(--rl-ink-3)' },
};

function NotifRow({ n, onClick }) {
  const meta = NOTIF_ICON[n.type] || NOTIF_ICON.sys;
  const Icon = meta.icon;
  return (
    <div
      onClick={onClick}
      className="px-4 py-2 flex items-start gap-2.5 transition hover:bg-slate-50 cursor-pointer"
      style={{ borderBottom: '1px solid var(--rl-border-soft)' }}
      title={n.category === 'system' ? '시스템 공지 새 창' : '환자 차트로 이동'}
    >
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        <Icon size={13} style={{ color: meta.color }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="text-xs font-medium truncate" style={{ color: 'var(--rl-ink)' }}>{n.title}</div>
          <div className="font-mono text-[10px] ml-auto flex-shrink-0" style={{ color: 'var(--rl-ink-3)' }}>{n.time}</div>
        </div>
        <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--rl-ink-3)' }}>{n.text}</div>
      </div>
      <ChevronRight size={11} style={{ color: 'var(--rl-ink-4)', flexShrink: 0, marginTop: 4 }} />
    </div>
  );
}

/* 시스템 공지 popup · 단일 알림 상세 */
function openSystemAnnouncementPopup(n) {
  const w = window.open('', `sys-${n.date}-${n.time}`, 'width=720,height=620,resizable=yes,scrollbars=yes');
  if (!w) {
    alert('팝업 차단을 해제해주세요.');
    return;
  }
  const d = n.detail || {};
  w.document.write(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>시스템 공지 · ${n.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html, body { margin: 0; padding: 0; }
  body { background: #F8FAFC; font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif; color: #0A1628; padding: 24px; -webkit-font-smoothing: antialiased; }
  .card { background: white; max-width: 640px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 6px; padding: 28px; }
  .label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; }
  .top { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid #E2E8F0; }
  .top .badge { padding: 3px 10px; background: #F1F5F9; color: #334155; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; }
  .top .when { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #64748B; }
  h1 { font-family: 'IBM Plex Serif', serif; font-size: 22px; margin: 14px 0 6px; letter-spacing: -0.01em; }
  .text { font-size: 13px; color: #334155; line-height: 1.6; margin-bottom: 16px; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0 16px; }
  .stat { padding: 10px 12px; background: #F1F5F9; border-radius: 4px; }
  .stat .l { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; }
  .stat .v { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: #0A1628; margin-top: 3px; }
  .changes {
    padding: 14px 16px; background: #EFF4FB; border-left: 3px solid #0C447C; border-radius: 4px;
    font-size: 12px; line-height: 1.6;
  }
  .changes .l { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #0C447C; margin-bottom: 6px; }
  .footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #E2E8F0; display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #94A3B8; }
</style>
</head>
<body>
  <div class="card">
    <div class="top">
      <span class="badge">System</span>
      <span class="label">${d.component || ''}</span>
      <span class="when">${n.date} ${n.time} KST</span>
    </div>
    <h1>${n.title}</h1>
    <div class="text">${n.text}</div>
    <div class="stats">
      ${d.version    ? `<div class="stat"><div class="l">Version</div><div class="v">${d.version}</div></div>` : ''}
      ${d.deployedBy ? `<div class="stat"><div class="l">Deployed by</div><div class="v">${d.deployedBy}</div></div>` : ''}
    </div>
    ${d.changes ? `<div class="changes"><div class="l">Changes · 변경 내역</div>${d.changes}</div>` : ''}
    <div class="footer">
      <span>Soo-Pul · System announcement</span>
      <span>EU AI Act Art. 22</span>
    </div>
  </div>
</body>
</html>`);
  w.document.close();
}

/* 알림 히스토리 popup · 전체 알림 리스트 + details/summary 클릭 expand */
function openNotificationHistoryPopup() {
  const w = window.open('', 'notif-history', 'width=820,height=900,resizable=yes,scrollbars=yes');
  if (!w) {
    alert('팝업 차단을 해제해주세요.');
    return;
  }

  const CAT_LABEL = { admit: '외래 추가 등록', result: '결과 도착', system: '시스템' };
  const TYPE_LABEL = {
    admit: { label: '외래 등록', color: '#0C447C', bg: '#EFF4FB' },
    cxr:   { label: 'CXR',       color: '#0E8574', bg: '#E6F5F2' },
    ai:    { label: 'AI',        color: '#B45309', bg: '#FEF3C7' },
    lab:   { label: 'Lab',       color: '#0E8574', bg: '#E6F5F2' },
    sys:   { label: '시스템',    color: '#64748B', bg: '#F1F5F9' },
  };

  const all = MOCK_NOTIFICATION_HISTORY.slice().sort((a, b) => {
    const da = `${a.date} ${a.time}`;
    const db = `${b.date} ${b.time}`;
    return db.localeCompare(da);
  });

  const counts = {
    total:  all.length,
    admit:  all.filter(n => n.category === 'admit').length,
    result: all.filter(n => n.category === 'result').length,
    system: all.filter(n => n.category === 'system').length,
  };

  const renderDetail = (n) => {
    const d = n.detail || {};
    const rows = Object.entries(d).map(([k, v]) => `
      <tr>
        <td class="dlabel">${k}</td>
        <td class="dval">${v}</td>
      </tr>`).join('');
    return `<table class="detail">${rows}</table>`;
  };

  const items = all.map((n, i) => {
    const t = TYPE_LABEL[n.type] || TYPE_LABEL.sys;
    return `
    <details class="item" data-cat="${n.category}">
      <summary>
        <span class="chip" style="background:${t.bg};color:${t.color}">${t.label}</span>
        <span class="title">${n.title}</span>
        <span class="text">${n.text}</span>
        <span class="when">${n.date} ${n.time}</span>
      </summary>
      <div class="body">
        <div class="cat mono small muted">CATEGORY · ${CAT_LABEL[n.category]}</div>
        ${renderDetail(n)}
      </div>
    </details>`;
  }).join('');

  w.document.write(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>알림 히스토리 · Soo-Pul</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html, body { margin: 0; padding: 0; }
  body { background: #F8FAFC; font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif; color: #0A1628; padding: 24px; -webkit-font-smoothing: antialiased; }
  .card { background: white; max-width: 720px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 6px; overflow: hidden; }
  header { padding: 18px 24px; border-bottom: 1px solid #E2E8F0; display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-family: 'IBM Plex Serif', serif; font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  header .label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #0C447C; }
  header .total { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #B45309; }
  .filters {
    padding: 10px 24px; border-bottom: 1px solid #E2E8F0; background: #F8FAFC;
    display: flex; align-items: center; gap: 6px;
  }
  .filters .lab { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; margin-right: 4px; }
  .filters button {
    padding: 4px 10px; border-radius: 4px; border: 1px solid #CBD5E1; background: white; cursor: pointer;
    font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
    color: #334155;
  }
  .filters button.active { background: #0C447C; color: white; border-color: #0C447C; }
  .filters button:hover:not(.active) { background: #F1F5F9; }
  .list { padding: 4px 0; }
  details.item { border-bottom: 1px solid #E2E8F0; }
  details.item[hidden] { display: none; }
  details.item summary {
    padding: 10px 24px; cursor: pointer; display: flex; align-items: center; gap: 10px;
    list-style: none; font-size: 12px;
  }
  details.item summary::-webkit-details-marker { display: none; }
  details.item summary:hover { background: #F8FAFC; }
  details.item[open] summary { background: #EFF4FB; }
  .chip {
    display: inline-block; padding: 2px 8px; border-radius: 3px;
    font-family: 'IBM Plex Mono', monospace; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.1em; flex-shrink: 0;
    min-width: 56px; text-align: center;
  }
  .title { font-weight: 500; flex-shrink: 0; }
  .text { color: #64748B; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .when { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #94A3B8; flex-shrink: 0; }
  .body { padding: 10px 24px 14px 90px; background: #F8FAFC; border-top: 1px solid #E2E8F0; }
  .cat { margin-bottom: 6px; }
  .small { font-size: 10px; }
  .muted { color: #64748B; }
  .mono { font-family: 'IBM Plex Mono', monospace; }
  table.detail { width: 100%; border-collapse: collapse; }
  table.detail td { padding: 4px 0; vertical-align: top; }
  td.dlabel {
    font-family: 'IBM Plex Mono', monospace; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.1em; color: #64748B;
    width: 110px; padding-right: 12px;
  }
  td.dval { font-size: 11px; color: #0A1628; }
  footer {
    padding: 10px 24px; border-top: 1px solid #E2E8F0;
    font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #94A3B8;
    display: flex; justify-content: space-between;
  }
</style>
</head>
<body>
  <div class="card">
    <header>
      <span class="label">Notification History</span>
      <h1>알림 히스토리</h1>
      <span class="total">전체 ${counts.total}건</span>
    </header>
    <div class="filters">
      <span class="lab">Filter</span>
      <button class="active" data-filter="all">전체 ${counts.total}</button>
      <button data-filter="admit">외래 등록 ${counts.admit}</button>
      <button data-filter="result">결과 도착 ${counts.result}</button>
      <button data-filter="system">시스템 ${counts.system}</button>
    </div>
    <div class="list">
      ${items}
    </div>
    <footer>
      <span>Soo-Pul · 최근 5일</span>
      <span>EU AI Act Art. 22</span>
    </footer>
  </div>
  <script>
    (function() {
      var btns = document.querySelectorAll('.filters button');
      var items = document.querySelectorAll('details.item');
      btns.forEach(function(b) {
        b.addEventListener('click', function() {
          btns.forEach(function(x) { x.classList.remove('active'); });
          b.classList.add('active');
          var f = b.getAttribute('data-filter');
          items.forEach(function(it) {
            if (f === 'all' || it.getAttribute('data-cat') === f) {
              it.hidden = false;
            } else {
              it.hidden = true;
              it.removeAttribute('open');
            }
          });
        });
      });
    })();
  </script>
</body>
</html>`);
  w.document.close();
}

/* ----- TOPBAR · 세션 카운트다운 (클릭으로 연장) ----- */
function SessionCountdown() {
  const [remaining, setRemaining] = useState(() => {
    const s = loadSession();
    return s.expiresAt ? Math.max(0, s.expiresAt - Date.now()) : 0;
  });
  const [justRenewed, setJustRenewed] = useState(false);

  useEffect(() => {
    const tick = () => {
      const s = loadSession();
      setRemaining(s.expiresAt ? Math.max(0, s.expiresAt - Date.now()) : 0);
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  if (remaining <= 0) return null;

  const min = Math.floor(remaining / 60000);
  const sec = Math.floor((remaining % 60000) / 1000);
  const formatted = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

  const level =
    min < 5  ? { c: 'var(--rl-critical)', bg: 'var(--rl-critical-soft)' } :
    min < 10 ? { c: 'var(--rl-amber)',    bg: 'var(--rl-amber-soft)' } :
               { c: 'var(--rl-ink-2)',    bg: 'var(--rl-bg-3)' };

  const extend = () => {
    if (renewSession()) {
      setRemaining(getSessionTtlMin() * 60 * 1000);
      setJustRenewed(true);
      setTimeout(() => setJustRenewed(false), 900);
    }
  };

  return (
    <div className="flex items-center gap-1" title={`세션 잔여 ${min}분 ${sec}초 · TTL 1h`}>
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded font-mono text-[10px]"
        style={{ background: level.bg, color: level.c, transition: 'background 0.3s, color 0.3s' }}
      >
        <Clock size={11} />
        <span>{formatted}</span>
      </div>
      <button
        onClick={extend}
        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono uppercase tracking-widest hairline-strong hover:bg-slate-50 transition"
        style={{
          color: justRenewed ? 'var(--rl-teal)' : 'var(--rl-primary)',
          borderColor: justRenewed ? 'var(--rl-teal)' : undefined,
        }}
        title="세션 1시간 연장"
      >
        <RefreshCw size={10} className={justRenewed ? '' : ''} />
        {justRenewed ? '연장됨' : '연장'}
      </button>
    </div>
  );
}

export default function RareLinkApp() {
  const initial = loadSession();
  const [screen, setScreen] = useState(initial.doctor ? 'worklist' : 'login');
  const [doctor, setDoctor] = useState(initial.doctor);
  const [sessionExpired, setSessionExpired] = useState(initial.expired);
  const [pendingPatientMrn, setPendingPatientMrn] = useState(null);

  // 만료 감시 · 1분마다 확인 (탭 재활성화 시 즉시 확인)
  useEffect(() => {
    if (screen === 'login') return;
    const check = () => {
      const s = loadSession();
      if (!s.doctor) {
        clearSession();
        setDoctor(null);
        setScreen('login');
        setSessionExpired(true);
      }
    };
    const id = setInterval(check, 60 * 1000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [screen]);

  // PatientRow 의 Ctrl/⌘+클릭으로 열린 새 탭 — ?patient=mrn 이 있으면 로그인 후
  // 해당 환자 차트로 자동 진입. 한 번 처리한 후 URL 에서 제거(새로고침 재트리거 방지).
  useEffect(() => {
    if (!doctor || screen !== 'worklist') return;
    try {
      const sp = new URLSearchParams(window.location.search);
      const mrn = sp.get('patient');
      if (!mrn) return;
      setPendingPatientMrn(mrn);
      sp.delete('patient');
      const qs = sp.toString();
      const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', url);
    } catch (_) { /* noop */ }
  }, [doctor, screen]);

  // 실제 로그아웃은 doLogout — 사용자에게 노출되는 onLogout 은 confirm modal 을 띄움
  const doLogout = () => {
    clearSession();
    signOutCognito();
    setDoctor(null);
    setScreen('login');
  };
  const [confirmLogout, setConfirmLogout] = useState(false);
  const requestLogout = () => setConfirmLogout(true);

  // 알림 클릭 → 환자 차트로 이동 (다른 screen에 있으면 worklist로 navigate)
  const [pendingAnnouncement, setPendingAnnouncement] = useState(null);

  const openPatientByMrn = (mrn) => {
    if (!mrn) return;
    setPendingPatientMrn(mrn);
    setScreen('worklist');
  };
  const clearPendingPatient = () => setPendingPatientMrn(null);

  const openAnnouncement = (n) => {
    setPendingAnnouncement(n);
    setScreen('announcement');
  };

  const common = {
    doctor, onLogout: requestLogout, onNavigate: setScreen,
    onOpenPatient: openPatientByMrn,
    onOpenAnnouncement: openAnnouncement,
  };

  return (
    <EmrPendingProvider>
      <div className="min-h-screen" style={{ fontFamily: "'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif", background: 'var(--rl-bg-2)' }}>
        <style>{globalStyles}</style>
        {screen === 'login' && (
          <LoginScreen
            sessionExpired={sessionExpired}
            onLogin={(d) => {
              saveSession(d);
              setDoctor(d);
              setSessionExpired(false);
              setScreen('worklist');
              // VITE_USE_MOCK=true 면 no-op, false 면 SMART OAuth 리다이렉트 발동
              launchSmartForDoctor(d);
            }}
          />
        )}
        {screen === 'worklist'     && <WorklistScreen     {...common} pendingPatientMrn={pendingPatientMrn} onClearPendingPatient={clearPendingPatient} />}
        {screen === 'settings'     && <SettingsScreen     {...common} />}
        {screen === 'dashboard'    && <AnalyticsDashboard {...common} TopBar={TopBar} />}
        {screen === 'knowledge'    && <KnowledgeBaseScreen {...common} />}
        {screen === 'designsystem' && <RareLinkDesignSystem onBack={() => setScreen('settings')} />}
        {screen === 'announcement' && <AnnouncementScreen {...common} initialNotif={pendingAnnouncement} />}

        {confirmLogout && (
          <LogoutConfirmModal
            onCancel={() => setConfirmLogout(false)}
            onConfirm={() => { setConfirmLogout(false); doLogout(); }}
          />
        )}
      </div>
    </EmrPendingProvider>
  );
}

/* ----------- 로그아웃 확인 모달 — TopBar/Settings 로그아웃 버튼 클릭 시 ----------- */
function LogoutConfirmModal({ onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(10,22,40,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded fade-in"
        style={{ width: 380, padding: '22px 24px', boxShadow: '0 24px 60px rgba(10,22,40,0.35)' }}
      >
        <div className="flex items-center gap-2.5 mb-2.5">
          <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
            <LogOut size={15} />
          </div>
          <h3 className="font-medium" style={{ color: 'var(--rl-ink)', fontSize: 15 }}>로그아웃 확인</h3>
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--rl-ink-2)', lineHeight: 1.6 }}>
          정말 로그아웃 하시겠습니까? 진행 중인 진단·세션이 종료됩니다.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded text-xs font-medium hairline-strong hover:bg-slate-50 transition"
            style={{ color: 'var(--rl-ink-2)' }}
            autoFocus
          >취소</button>
          <button
            onClick={onConfirm}
            className="px-3.5 py-1.5 rounded text-xs font-medium transition hover:opacity-90 flex items-center gap-1.5"
            style={{ background: 'var(--rl-amber)', color: 'white' }}
          >
            <LogOut size={11} /> 로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   GLOBAL DESIGN TOKENS (from Design System v0.1)
   ============================================================ */
const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,500;0,600;1,400;1,500&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

  :root {
    --rl-ink:           #0A1628;
    --rl-ink-2:         #334155;
    --rl-ink-3:         #64748B;
    --rl-ink-4:         #94A3B8;
    --rl-border:        #CBD5E1;
    --rl-border-soft:   #E2E8F0;
    --rl-bg:            #FFFFFF;
    --rl-bg-2:          #F8FAFC;
    --rl-bg-3:          #F1F5F9;
    --rl-primary:       #0C447C;
    --rl-primary-dark:  #083158;
    --rl-primary-2:     #1D5FAB;
    --rl-primary-soft:  #EFF4FB;
    --rl-teal:          #0E8574;
    --rl-teal-soft:     #E6F5F2;
    --rl-amber:         #B45309;
    --rl-amber-soft:    #FEF3C7;
    --rl-critical:      #A32D2D;
    --rl-critical-soft: #FEE4E4;
    --rl-rare:          #6B21A8;
    --rl-rare-soft:     #F3E8FF;
  }

  .font-serif { font-family: 'IBM Plex Serif', Georgia, serif; }
  .font-mono  { font-family: 'IBM Plex Mono', monospace; }

  /* Bilingual support · 외국인 환자(영문 입력) 가독성 보정
   * Latin-only 문자열엔 lang="en" + .t-en 부착 → BiText helper 참고
   */
  .t-en, [lang="en"] {
    font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif;
    letter-spacing: -0.003em;
  }
  .t-en-serif {
    font-family: 'IBM Plex Serif', Georgia, serif;
    letter-spacing: -0.005em;
  }
  /* truncate를 쓰지 않는 영문 텍스트 컨테이너용 */
  .t-bilingual {
    word-break: keep-all;
    overflow-wrap: anywhere;
  }

  .hairline { border: 1px solid var(--rl-border-soft); }
  .hairline-strong { border: 1px solid var(--rl-border); }

  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 500; letter-spacing: 0.02em;
    white-space: nowrap;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.4; }
  }
  .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }

  @keyframes sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  @keyframes graph-pulse {
    0%, 100% { opacity: 0.7; }
    50%      { opacity: 0.25; }
  }

  @keyframes fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .fade-in { animation: fade-in 0.5s ease-out; }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .spin { animation: spin 1s linear infinite; }

  .row-hover:hover { background: var(--rl-primary-soft); cursor: pointer; }

  .drawer-bg {
    animation: fade-in 0.25s ease-out;
  }
`;

/* ============================================================
   SCREEN 01 · LOGIN
   ============================================================ */
function LoginScreen({ onLogin, sessionExpired }) {
  const [institution, setInstitution] = useState('skku');
  const [doctorId, setDoctorId] = useState('jeong.ms');
  const [password, setPassword] = useState('DemoPass123!');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(null); // null | 'oauth' | 'fhir' | 'synthea'
  const [loginError, setLoginError] = useState(null);

  const phases = [
    { key: 'oauth',   label: 'OAuth 2.0 토큰 교환 중',  d: 500 },
    { key: 'fhir',    label: 'FHIR R4 서버 핸드셰이크', d: 700 },
    { key: 'synthea', label: 'Synthea 환자 코호트 로드', d: 600 },
  ];

  const handleLogin = async () => {
    // Cognito User Pool 인증 — say2-2team-rare-link-pool.
    // 의사 메타데이터(소속·면허·EMR 벤더)는 ID 토큰 custom attributes 로 전달됨.
    setLoginError(null);
    setLoading(true);
    let doctor;
    try {
      doctor = await cognitoSignIn(doctorId, password);
    } catch (err) {
      setLoading(false);
      setPhase(null);
      setLoginError(err.message || '로그인에 실패했습니다.');
      return;
    }
    // 인증 성공 → OAuth/FHIR 핸드셰이크 연출 후 진입
    let acc = 0;
    phases.forEach((p, i) => {
      acc += p.d;
      setTimeout(() => setPhase(p.key), acc - p.d);
      if (i === phases.length - 1) {
        setTimeout(() => onLogin({
          id:          doctor.id,
          name:        doctor.name,
          role:        doctor.role,
          institution: doctor.institution,
          department:  doctor.department,
          licenseNo:   doctor.licenseNo,
          emrVendor:   doctor.emrVendor,
          email:       doctor.email,
        }), acc);
      }
    });
  };

  return (
    <div className="min-h-screen flex">
      {/* ============== LEFT: BRAND PANEL ============== */}
      <div className="flex-1 relative overflow-hidden hidden lg:flex flex-col justify-between p-12" style={{ background: 'var(--rl-primary-dark)', color: 'white' }}>
        {/* Grid backdrop */}
        <div className="absolute inset-0 opacity-30" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }} />

        {/* Sweeping light */}
        <div className="absolute top-1/3 left-0 right-0 h-32 opacity-15 pointer-events-none" style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)',
          animation: 'sweep 8s ease-in-out infinite',
        }} />

        {/* Header */}
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded flex items-center justify-center" style={{ background: 'white' }}>
              <Stethoscope size={20} style={{ color: 'var(--rl-primary-dark)' }} strokeWidth={2.5} />
            </div>
            <div>
              <div className="font-serif text-xl leading-none" style={{ letterSpacing: '-0.01em' }}>
                Soo-<span style={{ fontStyle: 'italic', fontWeight: 500 }}>Pul</span>
              </div>
              <div className="font-mono text-[10px] mt-1 uppercase tracking-widest opacity-60">
                SooNet-Pulmonary · SKKU AWS SAY 2기 · 2팀
              </div>
            </div>
          </div>
        </div>

        {/* Hero */}
        <div className="relative z-10">
          <div className="font-mono text-[10px] uppercase tracking-widest opacity-60 mb-4">
            Clinical Decision Support for Rare Pulmonary Disease
          </div>
          <h1 className="font-serif leading-tight mb-6" style={{ fontSize: '3.2rem', letterSpacing: '-0.02em' }}>
            의사가 <span style={{ fontStyle: 'italic' }}>이미 아는</span><br />
            언어로, 희귀질환을<br />
            놓치지 않게
          </h1>
          <p className="text-base leading-relaxed max-w-md opacity-80">
            DenseNet-121 흉부 X-선 모델과 다중모달 가중 스코어링 엔진이 <span className="font-serif italic">428</span>개 폐질환 중 임상 증거로 가장 뒷받침되는 감별진단을 제시하고, HPO 기반 Likelihood Ratio 로 희귀질환을 별도 평가합니다.
          </p>
        </div>

        {/* HPO Graph visual */}
        <div className="relative z-10 mt-auto">
          <HPOGraph />

          {/* Compliance strip */}
          <div className="flex items-center gap-3 mt-8 flex-wrap">
            {[
              { icon: <Shield size={12} />, label: 'EU AI Act · Art. 22' },
              { icon: <Shield size={12} />, label: 'FDA SaMD Framework' },
              { icon: <Zap size={12} />,    label: 'SMART on FHIR v2.2' },
              { icon: <Shield size={12} />, label: 'HIPAA · 개인정보보호법' },
            ].map(b => (
              <div key={b.label} className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
                {b.icon}
                <span className="font-mono text-[10px] uppercase tracking-wider opacity-80">{b.label}</span>
              </div>
            ))}
          </div>

          {/* 팀 크레딧 — SKKU AWS SAY 2기 2팀 */}
          <div className="mt-6 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            <div className="font-mono text-[9px] uppercase tracking-widest opacity-50 mb-2.5">
              Team · SKKU AWS SAY 2기 · 2팀
            </div>
            <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
              {[
                { name: '박성수', lead: true },
                { name: '권미라' },
                { name: '배기태' },
                { name: '양희인' },
                { name: '허태웅' },
              ].map(m => (
                <span key={m.name} className="flex items-center gap-1.5 text-[13px]" style={{ opacity: m.lead ? 1 : 0.78 }}>
                  {m.lead && (
                    <span
                      className="font-mono font-semibold flex items-center justify-center"
                      style={{
                        width: 16, height: 16, borderRadius: 3, fontSize: 9,
                        background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.32)',
                      }}
                      title="팀장"
                    >L</span>
                  )}
                  <span style={{ fontWeight: 400, letterSpacing: '0.01em' }}>{m.name}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ============== RIGHT: FORM PANEL ============== */}
      <div className="w-full lg:w-[480px] flex flex-col justify-center p-8 lg:p-12 bg-white">
        <div className="w-full max-w-sm mx-auto">
          <div className="font-mono text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--rl-primary)' }}>
            Clinician Login · {liveDateLabel()}
          </div>
          <h2 className="font-serif text-3xl mb-1" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>로그인</h2>
          <p className="text-sm mb-5" style={{ color: 'var(--rl-ink-3)' }}>
            의사 계정 또는 EMR SSO로 접속하세요.
          </p>

          {sessionExpired && (
            <div
              className="rounded px-3 py-2 mb-5 flex items-start gap-2 text-xs"
              style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)' }}
            >
              <Clock size={13} style={{ color: 'var(--rl-amber)', marginTop: 1, flexShrink: 0 }} />
              <div style={{ color: 'var(--rl-ink-2)' }}>
                <span className="font-medium" style={{ color: 'var(--rl-amber)' }}>세션이 만료되어 로그아웃되었습니다.</span>{' '}
                <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>TTL 1h</span> · 다시 로그인해주세요.
              </div>
            </div>
          )}

          {loginError && (
            <div
              className="rounded px-3 py-2 mb-5 flex items-start gap-2 text-xs"
              style={{ background: 'var(--rl-critical-soft)', border: '1px solid var(--rl-critical)' }}
            >
              <AlertTriangle size={13} style={{ color: 'var(--rl-critical)', marginTop: 1, flexShrink: 0 }} />
              <div style={{ color: 'var(--rl-ink-2)' }}>
                <span className="font-medium" style={{ color: 'var(--rl-critical)' }}>로그인 실패</span>
                {' · '}{loginError}
              </div>
            </div>
          )}

          {/* Institution */}
          <Field label="소속 기관" icon={<Activity size={14} />}>
            <select
              value={institution}
              onChange={e => setInstitution(e.target.value)}
              className="w-full px-3 py-2.5 rounded bg-white text-sm outline-none hairline-strong focus:border-[color:var(--rl-primary)]"
              style={{ color: 'var(--rl-ink)' }}
              disabled={loading}
            >
              <option value="skku">성균관대학교병원 · 호흡기내과</option>
              <option value="demo">AWS SAY 데모 병원</option>
              <option value="sandbox">SMART Health IT Sandbox</option>
            </select>
          </Field>

          {/* Doctor ID */}
          <Field label="의사 ID" icon={<User size={14} />}>
            <input
              value={doctorId}
              onChange={e => setDoctorId(e.target.value)}
              className="w-full px-3 py-2.5 rounded text-sm outline-none hairline-strong focus:border-[color:var(--rl-primary)]"
              style={{ color: 'var(--rl-ink)' }}
              disabled={loading}
            />
          </Field>

          {/* Password */}
          <Field label="비밀번호" icon={<Shield size={14} />}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded text-sm outline-none hairline-strong focus:border-[color:var(--rl-primary)] font-mono"
              style={{ color: 'var(--rl-ink)' }}
              disabled={loading}
            />
          </Field>

          {/* Primary Login */}
          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full py-3 rounded mt-2 text-sm font-medium flex items-center justify-center gap-2 transition hover:opacity-90"
            style={{ background: 'var(--rl-primary)', color: 'white', opacity: loading ? 0.9 : 1 }}
          >
            {loading ? <Loader2 size={16} className="spin" /> : <LogIn size={16} />}
            {loading ? '연결 중' : '로그인'}
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px" style={{ background: 'var(--rl-border-soft)' }} />
            <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>또는</span>
            <div className="flex-1 h-px" style={{ background: 'var(--rl-border-soft)' }} />
          </div>

          {/* SMART SSO */}
          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full py-3 rounded hairline-strong text-sm font-medium flex items-center justify-center gap-2 transition hover:bg-slate-50"
            style={{ color: 'var(--rl-primary)' }}
          >
            <Zap size={15} />
            EMR에서 실행 · SMART on FHIR SSO
          </button>

          {/* Loading phases */}
          {loading && (
            <div className="mt-6 space-y-2 fade-in">
              {phases.map(p => {
                const done = phases.findIndex(x => x.key === phase) > phases.findIndex(x => x.key === p.key);
                const active = phase === p.key;
                return (
                  <div key={p.key} className="flex items-center gap-2 text-xs">
                    {done ? (
                      <CheckCircle2 size={14} style={{ color: 'var(--rl-teal)' }} />
                    ) : active ? (
                      <Loader2 size={14} className="spin" style={{ color: 'var(--rl-primary)' }} />
                    ) : (
                      <Circle size={14} style={{ color: 'var(--rl-border)' }} />
                    )}
                    <span style={{ color: active || done ? 'var(--rl-ink)' : 'var(--rl-ink-3)' }}>{p.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer disclaimer */}
          <div className="mt-10 pt-5 text-[11px] leading-relaxed" style={{ borderTop: '1px solid var(--rl-border-soft)', color: 'var(--rl-ink-3)' }}>
            <div className="font-mono uppercase tracking-widest text-[10px] mb-1" style={{ color: 'var(--rl-amber)' }}>
              ⚠ Research / Educational Prototype
            </div>
            본 시스템은 SKKU AWS SAY 2기 2팀의 프로젝트이며 현재 SaMD 허가 전 연구·교육 목적의 프로토타입입니다. 모든 AI 출력은 주치의의 검토를 거쳐야 하며 치료 결정의 단독 근거로 사용될 수 없습니다.
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, icon, children }) {
  return (
    <div className="mb-3">
      <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: 'var(--rl-ink-2)' }}>
        <span style={{ color: 'var(--rl-ink-3)' }}>{icon}</span>
        {label}
      </label>
      {children}
    </div>
  );
}

function HPOGraph() {
  // Disease-symptom abstract network. Each dot = HPO term or disease node.
  const nodes = [
    { x: 60,  y: 30,  r: 5, type: 'disease' },
    { x: 140, y: 50,  r: 3, type: 'hpo' },
    { x: 100, y: 90,  r: 3, type: 'hpo' },
    { x: 200, y: 30,  r: 4, type: 'disease' },
    { x: 260, y: 80,  r: 3, type: 'hpo' },
    { x: 320, y: 40,  r: 5, type: 'disease' },
    { x: 180, y: 100, r: 3, type: 'hpo' },
    { x: 380, y: 80,  r: 3, type: 'hpo' },
    { x: 240, y: 130, r: 4, type: 'disease' },
    { x: 40,  y: 110, r: 3, type: 'hpo' },
    { x: 340, y: 130, r: 3, type: 'hpo' },
  ];
  const edges = [
    [0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 5], [2, 6], [6, 8], [4, 7], [5, 7], [6, 2], [9, 0], [10, 5], [8, 10], [7, 8],
  ];
  return (
    <svg viewBox="0 0 440 170" className="w-full" style={{ maxHeight: 170 }}>
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].x} y1={nodes[a].y}
          x2={nodes[b].x} y2={nodes[b].y}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth="0.8"
          style={{ animation: `graph-pulse 3.5s ease-in-out ${i * 0.15}s infinite` }}
        />
      ))}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle
            cx={n.x} cy={n.y} r={n.r + 3}
            fill="none"
            stroke={n.type === 'disease' ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.15)'}
            strokeWidth="0.8"
            style={{ animation: `graph-pulse 3s ease-in-out ${i * 0.2}s infinite` }}
          />
          <circle
            cx={n.x} cy={n.y} r={n.r}
            fill={n.type === 'disease' ? '#4DD4F5' : 'rgba(255,255,255,0.7)'}
          />
        </g>
      ))}
    </svg>
  );
}

/* ============================================================
   SCREEN 02 · HOME (Hub: 당일 외래 / 환자 검색 / 미확인 결과)
   ============================================================ */
/* 의사별 환자 배정 — 정민수(jeong.ms) 과장은 전체, 나머지 의사는 분배분만.
   당일 외래 30명을 호흡기내과 전임의·임상강사 4명에게 균등(8·8·7·7) 배정. */
const DOCTOR_ASSIGNMENT = {
  'park.jh': ['20-145982', '21-093127', '22-014556', '19-445621', '22-089433', '18-332108', '22-145012', '22-145098'],
  'kim.mj':  ['22-145103', '23-145220', '26-FOR0042', '26-145982', '26-098234', '26-204017', '26-301102', '26-415523'],
  'lee.sj':  ['24-115301', '24-201888', '24-302445', '23-088107', '23-156709', '23-204556', '26-411289'],
  'choi.ya': ['22-318902', '20-445188', '26-501712', '21-509822', '22-721033', '26-FOR0089', '26-FOR0117'],
};

/* 발표 기준일 — 워크리스트 '당일 외래'·'예약' 분류 기준 (live 시계와 별개로 고정). */
const DEMO_TODAY = '2026-05-28';

/* 환자별 진료/예약 날짜 — 의사별 8명 기준 ≈ 과거4·당일(5/28)3·예약(5/29)1 비율.
   과거 = 최근 진료 완료, 당일 = 5/28 외래, 예약 = 5/29 예정. */
const PATIENT_VISIT_DATE = {
  // park.jh
  '20-145982': '2026-05-20', '21-093127': '2026-05-13', '22-014556': '2026-05-24', '19-445621': '2026-05-06',
  '22-089433': '2026-05-28', '18-332108': '2026-05-28', '22-145012': '2026-05-28', '22-145098': '2026-05-29',
  // kim.mj
  '22-145103': '2026-05-17', '23-145220': '2026-05-09', '26-FOR0042': '2026-05-25', '26-145982': '2026-05-11',
  '26-098234': '2026-05-28', '26-204017': '2026-05-28', '26-301102': '2026-05-28', '26-415523': '2026-05-29',
  // lee.sj
  '24-115301': '2026-05-21', '24-201888': '2026-05-15', '24-302445': '2026-05-26', '23-088107': '2026-05-04',
  '23-156709': '2026-05-28', '23-204556': '2026-05-28', '26-411289': '2026-05-29',
  // choi.ya
  '22-318902': '2026-05-19', '20-445188': '2026-05-07', '26-501712': '2026-05-27', '21-509822': '2026-05-02',
  '22-721033': '2026-05-28', '26-FOR0089': '2026-05-28', '26-FOR0117': '2026-05-29',
};

/* 환자 → 방문 분류: 'today'(5/28 당일) | 'booked'(5/29 예약) | 'past'(최근 진료) */
function visitClassOf(mrn) {
  const d = PATIENT_VISIT_DATE[mrn] || DEMO_TODAY;
  if (d === DEMO_TODAY) return 'today';
  if (d > DEMO_TODAY)   return 'booked';
  return 'past';
}

/* 갱신 데이터 환자 — 당일 외래가 아니지만(과거 진료 환자) 새 데이터가 도착해
   끌어와 재검토가 필요한 케이스. (mrn → 갱신 내역)
   참조: 사용자 요구 — "외래환자가 아니더라도 업데이트할 데이터가 있는 환자" */
const PATIENT_DATA_UPDATES = {
  '21-093127': { kind: 'lab',  label: 'KL-6 추적검사 결과 도착',  detail: 'KL-6 1284 → 1102 U/mL · 외부 검사실 회신',     at: '2026-05-27 14:20' },
  '19-445621': { kind: 'cxr',  label: '외부병원 CXR 판독 회신',    detail: '타원 영상 CD 판독 — 우하엽 음영 추적 비교',     at: '2026-05-27 09:05' },
  '23-088107': { kind: 'note', label: '경과기록·HPO 표현형 갱신',  detail: '류마티스내과 협진 회신 + 신규 증상 3건 추가',   at: '2026-05-26 17:40' },
  '22-145103': { kind: 'lab',  label: 'ANCA 패널 결과 도착',       detail: 'PR3-ANCA 양성 전환 · 혈관염 재평가 권고',       at: '2026-05-27 11:30' },
};

/* live 현재 시각 — 발표 당일 자동으로 그날 날짜가 표기되도록 한다.
   워크리스트 '당일 외래' 기준일(DEMO_TODAY)과는 별개. */
const _WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _pad2 = (n) => String(n).padStart(2, '0');
function liveDateLabel(d = new Date()) {
  return `${d.getFullYear()}.${_pad2(d.getMonth() + 1)}.${_pad2(d.getDate())} (${_WD[d.getDay()]})`;
}
function liveTimeLabel(d = new Date()) {
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
}

/* 'YYYY-MM-DD' → 'M/D' (배지 표기용) */
function fmtMD(iso) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}

/* 방문 분류 배지 — 워크리스트에서 당일 외래·예약·최근 진료를 한눈에 구분. */
function VisitBadge({ cls, date }) {
  const map = {
    today:  { label: '당일',      bg: 'var(--rl-primary)',    fg: '#fff',            bd: 'transparent' },
    booked: { label: fmtMD(date), bg: 'var(--rl-amber-soft)', fg: 'var(--rl-amber)', bd: 'var(--rl-amber)' },
    past:   { label: fmtMD(date), bg: 'var(--rl-bg-3)',       fg: 'var(--rl-ink-3)', bd: 'var(--rl-border-soft)' },
  };
  const v = map[cls] || map.today;
  return (
    <span
      className="inline-flex items-center justify-center font-mono text-[10px] font-semibold rounded px-1.5 py-0.5"
      style={{ background: v.bg, color: v.fg, border: `1px solid ${v.bd}`, lineHeight: 1.25 }}
      title={cls === 'booked' ? `${date} 예약` : cls === 'past' ? `${date} 진료` : '오늘(5/28) 외래'}
    >
      {v.label}
    </span>
  );
}

function WorklistScreen({ doctor, onLogout, onNavigate, onOpenPatient, onOpenAnnouncement, pendingPatientMrn, onClearPendingPatient }) {
  const [section, setSection] = useState('today'); // 'today' | 'search' | 'unread'
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [contextList, setContextList] = useState([]);
  const [contextLabel, setContextLabel] = useState('');
  const [patients, setPatientsRaw] = useState(MOCK_PATIENTS);
  const [history] = useState(MOCK_PATIENT_HISTORY);
  const [smartError, setSmartError] = useState(null);
  const setPatients = setPatientsRaw;

  // 로그인한 의사에게 배정된 환자만 — jeong.ms(과장)는 전체 유지.
  // 각 환자에 진료/예약 날짜(visitDate)·분류(visitClass) 주입.
  const visiblePatients = (() => {
    const did = doctor?.id;
    const mine = did && DOCTOR_ASSIGNMENT[did];
    const base = !mine ? patients : patients.filter(p => new Set(mine).has(p.mrn));
    return base.map(p => ({
      ...p,
      visitDate:  PATIENT_VISIT_DATE[p.mrn] || DEMO_TODAY,
      visitClass: visitClassOf(p.mrn),
    }));
  })();

  // 갱신 데이터 환자 — 당일 외래가 아니어도 새 데이터가 도착한 환자.
  const updatePatients = visiblePatients
    .filter(p => PATIENT_DATA_UPDATES[p.mrn])
    .map(p => ({ ...p, update: PATIENT_DATA_UPDATES[p.mrn] }));

  // FHIR 토글 — VITE_USE_MOCK=false 일 때만 실데이터 시도.
  //   smart 모드: sessionStorage에 SMART_AUTHORIZED 있을 때 ready 클라이언트
  //   none  모드: VITE_FHIR_BASE_URL 설정만으로 anonymous 클라이언트 (EC2 HAPI 등)
  // 실패 시 mock fallback (graceful degradation). 참조: CLAUDE.md §9
  useEffect(() => {
    const useMock = import.meta.env.VITE_USE_MOCK !== 'false';
    if (useMock || !canFetchFhir()) return;

    let cancelled = false;
    getClient()
      .then(client => fetchPatients(client))
      .then(list => { if (!cancelled) setPatients(list); })
      .catch(err => { if (!cancelled) { setSmartError(err.message); console.error('[FHIR fetch failed]', err); } });
    return () => { cancelled = true; };
  }, []);

  // FastAPI 워크리스트 endpoint — S3-backed mock EMR (또는 HAPI proxy).
  // 백엔드가 살아있으면 API 응답으로 환자 목록 교체. 실패 시 MOCK 유지.
  useEffect(() => {
    let cancelled = false;
    const today = new Date().toISOString().slice(0, 10);
    backend.worklist.list(today)
      .then((wl) => {
        if (cancelled) return;
        if (wl && Array.isArray(wl.patients) && wl.patients.length > 0) {
          setPatients(wl.patients);
          console.info('[worklist] loaded from /api/v1/worklist · ' + wl.count + ' patients');
        }
      })
      .catch((err) => {
        console.warn('[worklist] API unavailable — using local MOCK', err.status || err.message);
      });
    return () => { cancelled = true; };
  }, []);

  const acknowledge = (mrn) =>
    setPatients(ps => ps.map(p => (p.mrn === mrn ? { ...p, acknowledged: true } : p)));

  const unreadCount = visiblePatients.filter(p => p.status === 'ready' && !p.acknowledged).length;

  // ─── EMR 데이터 연동 상태 ────────────────────────────────────
  // linkedMrns: EMR → 시스템 연동 완료된 환자 MRN 집합.
  //   demo (?demo=1): "연동하기" 클릭 시 frontend state 토글 (시뮬레이션)
  //   일반 모드:      "연동하기" 클릭 시 GET /api/v1/patients/{mrn} 실제 호출 후 토글
  // localStorage 에 persist — 발표 중 새로고침해도 유지. (demo 는 별도 key)
  const demoMode = (() => {
    try { const v = new URLSearchParams(window.location.search).get('demo'); return v === '1' || v === 'true'; }
    catch (_) { return false; }
  })();
  const LINK_KEY = demoMode ? 'rl_linked_mrns_demo' : 'rl_linked_mrns';
  const [linkedMrns, setLinkedMrns] = useState(() => {
    try {
      const raw = localStorage.getItem(LINK_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) { return new Set(); }
  });
  const [linkingMrns, setLinkingMrns] = useState(new Set());  // 연동 진행 중

  function persistLinked(next) {
    try { localStorage.setItem(LINK_KEY, JSON.stringify([...next])); } catch (_) {}
  }

  async function linkPatient(mrn) {
    if (linkedMrns.has(mrn) || linkingMrns.has(mrn)) return;
    setLinkingMrns(prev => new Set(prev).add(mrn));
    try {
      if (!demoMode) {
        // 일반 모드 — 실제 backend 호출로 Aurora 데이터 확인
        await backend.patients.get(mrn);
      } else {
        // demo — 시뮬레이션 (실제 EMR 연동 시간 흉내)
        await new Promise(r => setTimeout(r, 600));
      }
      setLinkedMrns(prev => {
        const next = new Set(prev).add(mrn);
        persistLinked(next);
        return next;
      });
    } catch (err) {
      console.warn('[link] failed mrn=' + mrn, err.status || err.message);
      alert(`환자 ${mrn} 연동 실패 — EMR 데이터를 찾을 수 없습니다.`);
    } finally {
      setLinkingMrns(prev => { const n = new Set(prev); n.delete(mrn); return n; });
    }
  }

  async function linkAll() {
    const unlinked = visiblePatients.filter(p => !linkedMrns.has(p.mrn)).map(p => p.mrn);
    for (const mrn of unlinked) {
      // eslint-disable-next-line no-await-in-loop
      await linkPatient(mrn);
    }
  }

  const openPatient = (patient, list, label) => {
    setContextList(list);
    setContextLabel(label);
    setSelectedPatient(patient);
  };

  // 알림에서 진입한 환자 mrn → 환자 풀에서 찾아서 차트 열기
  const handleOpenPatient = (mrn) => {
    if (!mrn) return;
    const all = [...visiblePatients, ...history];
    const p = all.find(x => x.mrn === mrn);
    if (!p) {
      alert(`환자 정보를 찾을 수 없습니다 · MRN ${mrn}`);
      return;
    }
    const isToday = visiblePatients.some(x => x.mrn === mrn);
    const list  = isToday ? visiblePatients : [p];
    const label = isToday ? `당일 외래 · ${visiblePatients.length}명` : `알림에서 진입 · ${p.name}`;
    openPatient(p, list, label);
  };

  // 다른 screen에서 navigate 후 진입한 경우 (Settings·Dashboard 등에서 알림 클릭)
  useEffect(() => {
    if (!pendingPatientMrn) return;
    handleOpenPatient(pendingPatientMrn);
    onClearPendingPatient && onClearPendingPatient();
  }, [pendingPatientMrn]);

  // 환자 선택 시: EMR 차트 레이아웃 (좌 사이드바 + 메인 차트)
  if (selectedPatient) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: 'var(--rl-bg-2)' }}>
        <TopBar doctor={doctor} onLogout={onLogout} activeScreen="worklist" onNavigate={onNavigate} onOpenPatient={handleOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />
        <ChartLayout
          patient={selectedPatient}
          list={contextList}
          contextLabel={contextLabel}
          onSelect={setSelectedPatient}
          onHome={() => setSelectedPatient(null)}
          onAcknowledge={acknowledge}
          linkedMrns={linkedMrns}
          onLink={linkPatient}
        />
      </div>
    );
  }

  // 미선택 시: 허브 (3 섹션)
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rl-bg-2)' }}>
      <TopBar doctor={doctor} onLogout={onLogout} activeScreen="worklist" onNavigate={onNavigate} onOpenPatient={handleOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-8 py-6">
        <HomeHeader doctor={doctor} unreadCount={unreadCount} />

        <SectionNav
          active={section}
          onChange={setSection}
          counts={{
            today: visiblePatients.length,
            unread: unreadCount,
            updates: updatePatients.length,
          }}
        />

        {section === 'today' && (
          <TodaySection
            patients={visiblePatients}
            onSelect={(p) => openPatient(p, visiblePatients, `당일 외래 · ${visiblePatients.length}명`)}
            linkedMrns={linkedMrns}
            linkingMrns={linkingMrns}
            onLink={linkPatient}
            onLinkAll={linkAll}
          />
        )}
        {section === 'search' && (
          <SearchSection
            allPatients={[...visiblePatients, ...history]}
            onSelect={(p, list) => openPatient(p, list, `검색 결과 · ${list.length}명`)}
          />
        )}
        {section === 'unread' && (
          <UnreadSection
            patients={visiblePatients}
            onSelect={(p, list) => openPatient(p, list, `미확인 결과 · ${list.length}건`)}
            onAcknowledge={acknowledge}
          />
        )}
        {section === 'updates' && (
          <UpdatesSection
            patients={updatePatients}
            onSelect={(p) => openPatient(p, updatePatients, `갱신 데이터 · ${updatePatients.length}건`)}
          />
        )}

        {/* HITL footer reminder · 모든 섹션 공통 */}
        <div className="mt-6 rounded px-4 py-3 text-xs flex items-start gap-2" style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--rl-amber)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ color: 'var(--rl-ink-2)' }}>
            <span className="font-medium" style={{ color: 'var(--rl-amber)' }}>본 시스템의 모든 AI 분석 결과는 진단 보조용입니다.</span>{' '}
            환자에 대한 최종 진단 및 치료 결정은 반드시 주치의의 임상적 판단에 따라야 합니다.
            <span className="font-mono ml-2" style={{ color: 'var(--rl-ink-3)' }}>[EU AI Act Art. 22]</span>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ----------- HOME HEADER ----------- */
function HomeHeader({ doctor, unreadCount }) {
  return (
    <div className="flex items-baseline gap-4 mb-4">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-ink-3)' }}>
          Home · {liveDateLabel()} · KST
        </div>
        <h1 className="font-serif text-3xl" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
          {doctor.name} 과장님, 안녕하세요.
        </h1>
      </div>
      <div className="ml-auto flex items-center gap-4 text-xs" style={{ color: 'var(--rl-ink-3)' }}>
        {unreadCount > 0 && (
          <span className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
            <Inbox size={12} />
            <span className="font-medium">미확인 {unreadCount}건</span>
          </span>
        )}
        <span className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--rl-teal)' }} />
          <span className="font-mono">FHIR sync · {liveTimeLabel()}</span>
        </span>
      </div>
    </div>
  );
}

/* ----------- SECTION NAV (sub-tabs) ----------- */
function SectionNav({ active, onChange, counts }) {
  const tabs = [
    { k: 'today',   label: '당일 외래',       icon: <CalendarDays size={14} />, count: counts.today,   accent: 'primary' },
    { k: 'updates', label: '갱신 데이터',     icon: <RefreshCw size={14} />,    count: counts.updates, accent: 'teal',  alert: counts.updates > 0 },
    { k: 'search',  label: '환자 검색',       icon: <Search size={14} />,       count: null,           accent: 'ink' },
    { k: 'unread',  label: '미확인 환자결과', icon: <Inbox size={14} />,        count: counts.unread,  accent: 'amber', alert: counts.unread > 0 },
  ];
  return (
    <div className="hairline rounded bg-white p-1 mb-4 flex items-center gap-1">
      {tabs.map(t => {
        const isActive = active === t.k;
        return (
          <button
            key={t.k}
            onClick={() => onChange(t.k)}
            className="flex-1 px-4 py-2.5 rounded text-sm font-medium transition flex items-center justify-center gap-2"
            style={{
              background: isActive ? 'var(--rl-primary)' : 'transparent',
              color: isActive ? 'white' : 'var(--rl-ink-2)',
            }}
          >
            <span style={{ color: isActive ? 'white' : `var(--rl-${t.accent === 'ink' ? 'ink-3' : t.accent})` }}>
              {t.icon}
            </span>
            {t.label}
            {t.count !== null && (
              <span
                className="font-mono text-[11px] px-1.5 py-0.5 rounded"
                style={{
                  background: isActive ? 'rgba(255,255,255,0.18)' : 'var(--rl-bg-3)',
                  color: isActive ? 'white' : 'var(--rl-ink-2)',
                }}
              >
                {t.count}
              </span>
            )}
            {t.alert && !isActive && (
              <span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--rl-amber)' }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   SECTION A · 당일 외래
   ============================================================ */
function TodaySection({ patients, onSelect, linkedMrns = new Set(), linkingMrns = new Set(), onLink, onLinkAll }) {
  const [filter, setFilter] = useState('all');
  // '당일 외래' 섹션 진입 시 하위 필터도 '당일 외래'로 통일 — 의도 일치
  const [vClass, setVClass] = useState('today');   // 'all'|'today'|'booked'|'past'
  const [search, setSearch] = useState('');

  const filtered = patients.filter(p => {
    if (search) {
      const s = search.toLowerCase();
      if (!p.name.toLowerCase().includes(s) && !p.mrn.toLowerCase().includes(s)) return false;
    }
    if (vClass !== 'all' && p.visitClass !== vClass) return false;
    if (filter === 'all') return true;
    if (filter === 'rare') return p.rare || p.dontMiss;
    return p.status === filter;
  });

  const stats = {
    total: patients.length,
    analyzed: patients.filter(p => p.status === 'ready').length,
    analyzing: patients.filter(p => p.status === 'analyzing').length,
    rare: patients.filter(p => p.rare).length,
  };
  const vCount = {
    today:  patients.filter(p => p.visitClass === 'today').length,
    booked: patients.filter(p => p.visitClass === 'booked').length,
    past:   patients.filter(p => p.visitClass === 'past').length,
  };

  return (
    <div className="fade-in">
      {/* 상단 강조 — 의사가 화면을 열자마자 시선이 가는 핵심 작업 두 가지.
          좌: 즉각 조치 필요(희귀/Don't miss · 미확인) · 우: AI 분석 완료 미확인.
          전체 목록은 그 아래로 밀어 스크롤로 확인하도록 시선 흐름 정리. */}
      <PriorityRow patients={patients} onSelect={onSelect} />

      {/* Stats · 카드 클릭 시 필터 적용 (같은 카드 재클릭 시 전체로) */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCard
          label="배정 환자 전체"
          value={stats.total}     unit="명"
          icon={<User size={14} />}            accent="primary"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <StatCard
          label="AI 분석 완료"
          value={stats.analyzed}  unit="/ " totalUnit={stats.total + '명'}
          icon={<CheckCircle2 size={14} />}    accent="teal"
          active={filter === 'ready'}
          onClick={() => setFilter(filter === 'ready' ? 'all' : 'ready')}
        />
        <StatCard
          label="분석 중"
          value={stats.analyzing} unit="명"
          icon={<Loader2 size={14} className="spin" />} accent="ink"
          active={filter === 'analyzing'}
          onClick={() => setFilter(filter === 'analyzing' ? 'all' : 'analyzing')}
        />
        <StatCard
          label="희귀질환 의심"
          value={stats.rare}      unit="건"
          icon={<Flame size={14} />}           accent="rare"
          active={filter === 'rare'}
          onClick={() => setFilter(filter === 'rare' ? 'all' : 'rare')}
        />
      </div>

      {/* Filter Bar */}
      <div className="hairline rounded bg-white p-2 mb-3 flex items-center gap-1">
        <ListFilter size={14} style={{ color: 'var(--rl-ink-3)', margin: '0 8px' }} />

        {/* 방문 분류 필터 — 당일 외래 / 예약 / 최근 진료 */}
        {[
          { k: 'all',    label: '전체 방문', n: patients.length },
          { k: 'today',  label: '당일 외래', n: vCount.today,  c: 'var(--rl-primary)' },
          { k: 'booked', label: '예약',      n: vCount.booked, c: 'var(--rl-amber)' },
          { k: 'past',   label: '최근 진료', n: vCount.past,   c: 'var(--rl-ink-3)' },
        ].map(v => (
          <button
            key={v.k}
            onClick={() => setVClass(v.k)}
            className="px-2.5 py-1.5 rounded text-xs font-medium transition flex items-center gap-1.5"
            style={{
              background: vClass === v.k ? 'var(--rl-ink)' : 'transparent',
              color: vClass === v.k ? 'white' : 'var(--rl-ink-2)',
            }}
          >
            {v.c && <span className="w-1.5 h-1.5 rounded-full" style={{ background: vClass === v.k ? 'white' : v.c }} />}
            {v.label}
            <span className="font-mono" style={{ opacity: 0.7 }}>{v.n}</span>
          </button>
        ))}
        <span className="self-stretch w-px mx-1.5" style={{ background: 'var(--rl-border-soft)' }} />

        {[
          { k: 'all',       label: '전체',           n: patients.length },
          { k: 'pending',   label: '대기',           n: patients.filter(p => p.status === 'pending').length },
          { k: 'analyzing', label: '분석 중',        n: patients.filter(p => p.status === 'analyzing').length },
          { k: 'ready',     label: '결과 대기 확인', n: patients.filter(p => p.status === 'ready').length },
          { k: 'rare',      label: '희귀 플래그',    n: patients.filter(p => p.rare || p.dontMiss).length, flag: true },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className="px-3 py-1.5 rounded text-xs font-medium transition flex items-center gap-1.5"
            style={{
              background: filter === f.k ? 'var(--rl-primary)' : 'transparent',
              color: filter === f.k ? 'white' : 'var(--rl-ink-2)',
            }}
          >
            {f.flag && <Flame size={11} style={{ color: filter === f.k ? 'white' : 'var(--rl-rare)' }} />}
            {f.label}
            <span className="font-mono" style={{ opacity: 0.7 }}>{f.n}</span>
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2 pr-2">
          {/* 전체 연동하기 — 미연동 환자 일괄 EMR 연동 */}
          {(() => {
            const unlinkedCount = patients.filter(p => !linkedMrns.has(p.mrn)).length;
            const linking = linkingMrns.size > 0;
            if (unlinkedCount === 0) {
              return (
                <span className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded"
                  style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
                  <CheckCircle2 size={12} /> 전체 연동 완료
                </span>
              );
            }
            return (
              <button
                onClick={onLinkAll}
                disabled={linking}
                className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded transition hover:opacity-90"
                style={{
                  background: linking ? 'var(--rl-bg-3)' : 'var(--rl-primary)',
                  color: linking ? 'var(--rl-ink-3)' : 'white',
                  cursor: linking ? 'wait' : 'pointer',
                }}
                title="미연동 환자 전체를 EMR 에서 일괄 연동"
              >
                {linking ? <Loader2 size={12} className="spin" /> : <Database size={12} />}
                {linking ? '연동 중…' : `전체 연동하기 (${unlinkedCount})`}
              </button>
            );
          })()}
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--rl-ink-3)' }} />
            <input
              placeholder="이름 / Name 또는 MRN"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-7 pr-3 py-1.5 rounded text-xs hairline-strong outline-none w-48 focus:border-[color:var(--rl-primary)]"
            />
          </div>
        </div>
      </div>

      {/* Worklist Table */}
      <div className="hairline rounded bg-white overflow-hidden">
        <div className="grid px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest" style={{
          gridTemplateColumns: '68px 1.1fr 1.5fr 64px 70px 64px 130px 0.8fr 76px',
          color: 'var(--rl-ink-3)',
          background: 'var(--rl-bg-3)',
          borderBottom: '1px solid var(--rl-border-soft)',
        }}>
          <div>방문</div>
          <div>환자 정보</div>
          <div>주호소 · 소견</div>
          <div>CXR</div>
          <div>AI</div>
          <div>Lab</div>
          <div>EMR 연동</div>
          <div>플래그</div>
          <div style={{ textAlign: 'right' }}>액션</div>
        </div>

        {filtered.map((p, i) => (
          <PatientRow
            key={p.mrn}
            p={p}
            onClick={() => onSelect(p)}
            isLast={i === filtered.length - 1}
            linked={linkedMrns.has(p.mrn)}
            linking={linkingMrns.has(p.mrn)}
            onLink={onLink}
          />
        ))}

        {filtered.length === 0 && (
          <div className="p-10 text-center text-sm" style={{ color: 'var(--rl-ink-3)' }}>
            조건에 맞는 환자가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------- 홈 상단 강조: 즉각 조치 필요 + AI 분석 완료 미확인 -----------
   참조: 사용자 요구 — "사람의 시선 흐름(좌→우, 위→아래, 의료 환경은 중앙 집중) 고려한 레이아웃"
   - 좌: 희귀·Don't miss 환자 중 미확인 (acknowledged=false)
   - 우: AI 분석 완료(status=ready) 중 미확인
   - 각 박스 최대 4명까지 미니카드, 나머지는 카운트만 표기 → 전체 목록은 아래 테이블에서 확인 */
function PriorityRow({ patients, onSelect }) {
  const critical = patients.filter(p => (p.rare || p.dontMiss) && !p.acknowledged);
  const reviewable = patients.filter(p => p.status === 'ready' && !p.acknowledged);
  return (
    <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <PriorityCard
        title="즉각 조치 필요"
        sub="희귀 / Don't miss · 미확인"
        icon={<AlertTriangle size={14} />}
        accent="critical"
        items={critical}
        onSelect={onSelect}
      />
      <PriorityCard
        title="AI 분석 완료 · 미확인"
        sub="결과 검토 대기"
        icon={<CheckCircle2 size={14} />}
        accent="primary"
        items={reviewable}
        onSelect={onSelect}
      />
    </div>
  );
}

function PriorityCard({ title, sub, icon, accent, items, onSelect }) {
  const cols = {
    critical: { fg: 'var(--rl-amber)',   bg: 'var(--rl-amber-soft)',   border: 'var(--rl-amber)' },
    primary:  { fg: 'var(--rl-primary)', bg: 'var(--rl-primary-soft)', border: 'var(--rl-primary)' },
  }[accent];
  return (
    <div className="rounded bg-white" style={{ border: `1px solid ${cols.border}`, overflow: 'hidden' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: cols.bg, color: cols.fg }}>
        {icon}
        <span className="text-sm font-medium">{title}</span>
        <span className="font-mono text-[9px] uppercase tracking-widest opacity-75">· {sub}</span>
        <span className="ml-auto font-mono text-xs font-semibold">{items.length}건</span>
      </div>
      {items.length === 0 ? (
        <div className="py-5 text-center text-xs" style={{ color: 'var(--rl-ink-3)' }}>
          해당 환자 없음 · 모두 처리됨
        </div>
      ) : (
        <div>
          {items.slice(0, 4).map((p, i) => (
            <PriorityChip
              key={p.mrn}
              p={p}
              accent={cols.fg}
              onSelect={onSelect}
              isLast={i === Math.min(items.length, 4) - 1 && items.length <= 4}
            />
          ))}
          {items.length > 4 && (
            <div className="px-3 py-1.5 text-[10px] font-mono text-center"
              style={{ color: 'var(--rl-ink-3)', borderTop: '1px solid var(--rl-border-soft)' }}>
              + {items.length - 4}명 더 · 하단 목록에서 확인
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PriorityChip({ p, accent, onSelect, isLast }) {
  return (
    <button
      onClick={() => onSelect && onSelect(p)}
      className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-slate-50 transition"
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--rl-border-soft)' }}
    >
      <VisitBadge cls={p.visitClass} date={p.visitDate} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}>
          <BiText>{p.name}</BiText>
          <span className="font-normal" style={{ color: 'var(--rl-ink-2)' }}> · {p.sex}/{p.age}</span>
        </div>
        <div className="font-mono text-[10px] truncate" style={{ color: 'var(--rl-ink-3)' }}>
          {p.mrn} · {p.time} · {p.topDx || (p.preview && p.preview[0] && p.preview[0].name) || '주호소: ' + (p.complaint || '—').slice(0, 18)}
        </div>
      </div>
      {p.rare && (
        <span className="chip flex-shrink-0" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
          <Flame size={9} /> 희귀
        </span>
      )}
      {p.dontMiss && !p.rare && (
        <span className="chip flex-shrink-0" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
          <AlertTriangle size={9} /> Don't miss
        </span>
      )}
      <ChevronRight size={13} style={{ color: accent, flexShrink: 0 }} />
    </button>
  );
}

/* ============================================================
   SECTION A-2 · 갱신 데이터 (당일 외래 외 신규 데이터 환자)
   ============================================================ */
function UpdatesSection({ patients, onSelect }) {
  const [pulled, setPulled] = useState(() => new Set());
  const pull = (mrn) => setPulled(s => { const n = new Set(s); n.add(mrn); return n; });
  const pullAll = () => setPulled(new Set(patients.map(p => p.mrn)));

  const kindMeta = {
    lab:  { label: 'Lab 결과', icon: <FlaskConical size={11} />, c: 'var(--rl-amber)',   bg: 'var(--rl-amber-soft)' },
    cxr:  { label: 'CXR 영상', icon: <ScanLine size={11} />,     c: 'var(--rl-primary)', bg: 'var(--rl-primary-soft)' },
    note: { label: '경과기록', icon: <FileText size={11} />,     c: 'var(--rl-teal)',    bg: 'var(--rl-teal-soft)' },
  };
  const remaining = patients.filter(p => !pulled.has(p.mrn)).length;

  return (
    <div className="fade-in">
      {/* 안내 배너 */}
      <div className="hairline rounded bg-white p-3 mb-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
          <RefreshCw size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--rl-ink)' }}>
            당일 외래 외 · 신규 데이터 도착 환자 {patients.length}명
          </div>
          <div className="text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>
            과거 진료 환자라도 Lab·CXR·경과기록이 갱신되면 EMR 에서 끌어와 재검토할 수 있습니다.
          </div>
        </div>
        {remaining > 0 ? (
          <button
            onClick={pullAll}
            className="flex items-center gap-1.5 text-[11px] font-medium px-3 py-2 rounded transition hover:opacity-90"
            style={{ background: 'var(--rl-primary)', color: 'white' }}
          >
            <Database size={12} /> 전체 데이터 받아오기 ({remaining})
          </button>
        ) : patients.length > 0 ? (
          <span className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-2 rounded"
            style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
            <CheckCircle2 size={12} /> 전체 수신 완료
          </span>
        ) : null}
      </div>

      {/* 목록 */}
      <div className="hairline rounded bg-white overflow-hidden">
        <div className="grid px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest" style={{
          gridTemplateColumns: '64px 1.3fr 2fr 168px 96px',
          color: 'var(--rl-ink-3)', background: 'var(--rl-bg-3)',
          borderBottom: '1px solid var(--rl-border-soft)',
        }}>
          <div>최근 진료</div>
          <div>환자 정보</div>
          <div>갱신 내역</div>
          <div>수신 시각</div>
          <div style={{ textAlign: 'right' }}>액션</div>
        </div>

        {patients.map((p, i) => {
          const u = p.update;
          const km = kindMeta[u.kind] || kindMeta.note;
          const isPulled = pulled.has(p.mrn);
          return (
            <div
              key={p.mrn}
              onClick={() => onSelect(p)}
              className="grid px-4 py-3 row-hover transition"
              style={{
                gridTemplateColumns: '64px 1.3fr 2fr 168px 96px',
                borderBottom: i === patients.length - 1 ? 'none' : '1px solid var(--rl-border-soft)',
                alignItems: 'center', cursor: 'pointer',
              }}
            >
              {/* 최근 진료일 */}
              <div><VisitBadge cls={p.visitClass} date={p.visitDate} /></div>

              {/* 환자 */}
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
                  <User size={12} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}>
                    <BiText>{p.name}</BiText> <span className="font-normal" style={{ color: 'var(--rl-ink-2)' }}>· {p.sex}/{p.age}</span>
                  </div>
                  <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>{p.mrn}</div>
                </div>
              </div>

              {/* 갱신 내역 */}
              <div className="min-w-0 pr-3">
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
                    style={{ background: km.bg, color: km.c }}>
                    {km.icon} {km.label}
                  </span>
                  <span className="text-sm truncate" style={{ color: 'var(--rl-ink)' }}>{u.label}</span>
                </div>
                <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--rl-ink-3)' }}>{u.detail}</div>
              </div>

              {/* 수신 시각 */}
              <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-2)' }}>{u.at}</div>

              {/* 액션 */}
              <div style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                {isPulled ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--rl-teal)' }}>
                    <CheckCircle2 size={12} /> 재분석 대기
                  </span>
                ) : (
                  <button
                    onClick={() => pull(p.mrn)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded transition hover:opacity-90"
                    style={{ background: 'var(--rl-primary)', color: 'white' }}
                    title="EMR 에서 갱신 데이터 끌어오기"
                  >
                    <Database size={11} /> 받아오기
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {patients.length === 0 && (
          <div className="p-10 text-center text-sm" style={{ color: 'var(--rl-ink-3)' }}>
            갱신된 데이터가 있는 환자가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   SECTION B · 환자 검색
   ============================================================ */
function SearchSection({ allPatients, onSelect }) {
  const [query, setQuery] = useState('');
  const [range, setRange] = useState('1m'); // 'today' | '1w' | '1m' | '3m' | 'all'
  const [flagFilter, setFlagFilter] = useState('all'); // 'all' | 'rare' | 'dontMiss' | 'allergy'

  const today = new Date('2026-04-23');
  const cutoffDays = { today: 0, '1w': 7, '1m': 30, '3m': 90, all: 99999 }[range];

  const filtered = allPatients.filter(p => {
    if (range !== 'all') {
      const d = p.visitDate ? new Date(p.visitDate) : today;
      const diff = (today - d) / (1000 * 60 * 60 * 24);
      if (diff > cutoffDays) return false;
    }
    if (flagFilter === 'rare'     && !p.rare)     return false;
    if (flagFilter === 'dontMiss' && !p.dontMiss) return false;
    if (flagFilter === 'allergy'  && !p.allergy)  return false;
    if (query) {
      const q = query.toLowerCase();
      // 영문 환자명도 대소문자 무관 매칭 (한글은 toLowerCase 영향 없음)
      const inName = p.name.toLowerCase().includes(q);
      const inMrn  = p.mrn.toLowerCase().includes(q);
      const inDx   = (p.preview || []).some(d => d.name.toLowerCase().includes(q));
      const inComplaint = (p.complaint || '').toLowerCase().includes(q);
      if (!inName && !inMrn && !inDx && !inComplaint) return false;
    }
    return true;
  });

  const ranges = [
    { k: 'today', label: '오늘' },
    { k: '1w',    label: '최근 1주' },
    { k: '1m',    label: '최근 1개월' },
    { k: '3m',    label: '최근 3개월' },
    { k: 'all',   label: '전체' },
  ];
  const flags = [
    { k: 'all',      label: '모든 플래그',      icon: null },
    { k: 'rare',     label: '희귀',             icon: <Flame size={11} />,          color: 'var(--rl-rare)' },
    { k: 'dontMiss', label: "Don't miss",       icon: <AlertTriangle size={11} />, color: 'var(--rl-amber)' },
    { k: 'allergy',  label: '알러지',           icon: <Ban size={11} />,           color: 'var(--rl-critical)' },
  ];

  return (
    <div className="fade-in">
      {/* Search input · large */}
      <div className="hairline rounded bg-white p-4 mb-3">
        <div className="flex items-center gap-3 mb-3">
          <Search size={18} style={{ color: 'var(--rl-primary)' }} />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="환자명 (한글/영문) · MRN · 주호소 · 진단명 으로 검색"
            className="flex-1 outline-none text-base"
            style={{ color: 'var(--rl-ink)' }}
          />
          {query && (
            <button onClick={() => setQuery('')} className="p-1 rounded hover:bg-slate-100" style={{ color: 'var(--rl-ink-3)' }}>
              <X size={14} />
            </button>
          )}
          <span className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>
            {filtered.length} / {allPatients.length}
          </span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1">
            <CalendarDays size={12} style={{ color: 'var(--rl-ink-3)', marginRight: 4 }} />
            {ranges.map(r => (
              <button
                key={r.k}
                onClick={() => setRange(r.k)}
                className="px-2.5 py-1 rounded text-[11px] font-medium transition"
                style={{
                  background: range === r.k ? 'var(--rl-primary-soft)' : 'transparent',
                  color: range === r.k ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="h-4 w-px" style={{ background: 'var(--rl-border-soft)' }} />

          <div className="flex items-center gap-1">
            <Filter size={12} style={{ color: 'var(--rl-ink-3)', marginRight: 4 }} />
            {flags.map(f => (
              <button
                key={f.k}
                onClick={() => setFlagFilter(f.k)}
                className="px-2.5 py-1 rounded text-[11px] font-medium transition flex items-center gap-1"
                style={{
                  background: flagFilter === f.k ? 'var(--rl-primary-soft)' : 'transparent',
                  color: flagFilter === f.k ? 'var(--rl-primary)' : (f.color || 'var(--rl-ink-3)'),
                }}
              >
                {f.icon}
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Result Table */}
      <div className="hairline rounded bg-white overflow-hidden">
        <div className="grid px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest" style={{
          gridTemplateColumns: '110px 1.3fr 2fr 140px 1fr 90px',
          color: 'var(--rl-ink-3)',
          background: 'var(--rl-bg-3)',
          borderBottom: '1px solid var(--rl-border-soft)',
        }}>
          <div>방문일</div>
          <div>환자 정보</div>
          <div>주호소 · 소견</div>
          <div>CXR · AI · Lab</div>
          <div>플래그</div>
          <div style={{ textAlign: 'right' }}>액션</div>
        </div>

        {filtered.map((p, i) => (
          <SearchResultRow
            key={p.mrn + (p.visitDate || '')}
            p={p}
            onClick={() => onSelect(p, filtered)}
            isLast={i === filtered.length - 1}
          />
        ))}

        {filtered.length === 0 && (
          <div className="p-10 text-center text-sm" style={{ color: 'var(--rl-ink-3)' }}>
            검색 조건에 맞는 환자가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}

function SearchResultRow({ p, onClick, isLast }) {
  const dateLabel = p.visitDate
    ? p.visitDate.replace(/^2026-/, '').replace('-', '/')
    : '오늘';
  return (
    <div
      onClick={onClick}
      className="grid px-4 py-3 row-hover transition"
      style={{
        gridTemplateColumns: '110px 1.3fr 2fr 140px 1fr 90px',
        borderBottom: isLast ? 'none' : '1px solid var(--rl-border-soft)',
        alignItems: 'center',
      }}
    >
      <div>
        <div className="font-mono text-sm font-medium" style={{ color: 'var(--rl-ink)' }}>{dateLabel}</div>
        <div className="font-mono text-[10px] uppercase" style={{ color: 'var(--rl-ink-3)' }}>{p.visit} · {p.time}</div>
      </div>

      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
          <User size={12} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}>
            <BiText>{p.name}</BiText> <span className="font-normal" style={{ color: 'var(--rl-ink-2)' }}>· {p.sex}/{p.age}</span>
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>{p.mrn}</div>
        </div>
      </div>

      <div className="min-w-0 pr-3">
        <div className="text-sm truncate" style={{ color: 'var(--rl-ink)' }}><BiText>{p.complaint}</BiText></div>
        {p.preview && p.preview[0] && (
          <div className="text-[11px] truncate" style={{ color: 'var(--rl-ink-3)' }}>
            Top dx: <BiText>{p.preview[0].name}</BiText> · {(p.preview[0].prob * 100).toFixed(0)}%
          </div>
        )}
      </div>

      <StatusTriCell cxr={p.cxr} ai={p.status} lab={getLabStatus(p)} />

      <div className="flex items-center gap-1.5 flex-wrap">
        {p.rare && (
          <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
            <Flame size={10} /> 희귀
          </span>
        )}
        {p.dontMiss && (
          <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
            <AlertTriangle size={10} /> Don't miss
          </span>
        )}
        {p.allergy && (
          <span className="chip" style={{ background: 'var(--rl-critical-soft)', color: 'var(--rl-critical)' }}>
            <Ban size={10} /> 알러지
          </span>
        )}
      </div>

      <div style={{ textAlign: 'right' }}>
        <button className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--rl-primary)', fontWeight: 500 }}>
          열기 <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   SECTION C · 미확인 환자결과
   ============================================================ */
function UnreadSection({ patients, onSelect, onAcknowledge }) {
  const unread = patients
    .filter(p => p.status === 'ready' && !p.acknowledged)
    .sort((a, b) => {
      const sev = (x) => (x.dontMiss ? 2 : 0) + (x.rare ? 1 : 0);
      const s = sev(b) - sev(a);
      if (s !== 0) return s;
      return (a.resultAt || '').localeCompare(b.resultAt || '');
    });

  const counts = {
    total: unread.length,
    dontMiss: unread.filter(p => p.dontMiss).length,
    rare: unread.filter(p => p.rare).length,
  };

  if (unread.length === 0) {
    return (
      <div className="fade-in hairline rounded bg-white p-12 text-center">
        <CheckCircle2 size={28} style={{ color: 'var(--rl-teal)', margin: '0 auto 10px' }} />
        <div className="text-sm font-medium" style={{ color: 'var(--rl-ink)' }}>모든 결과를 확인하셨습니다.</div>
        <div className="text-xs mt-1" style={{ color: 'var(--rl-ink-3)' }}>새로운 AI 분석 결과가 도착하면 이곳에 표시됩니다.</div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {/* Summary strip */}
      <div className="hairline rounded bg-white px-4 py-3 mb-3 flex items-center gap-5">
        <div className="flex items-center gap-2">
          <Inbox size={16} style={{ color: 'var(--rl-amber)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--rl-ink)' }}>
            확인이 필요한 결과 <span className="font-serif text-lg" style={{ color: 'var(--rl-amber)' }}>{counts.total}</span> 건
          </span>
        </div>
        <div className="h-4 w-px" style={{ background: 'var(--rl-border-soft)' }} />
        {counts.dontMiss > 0 && (
          <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--rl-amber)' }}>
            <AlertTriangle size={12} />
            Don't miss <span className="font-mono font-medium">{counts.dontMiss}</span>
          </span>
        )}
        {counts.rare > 0 && (
          <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--rl-rare)' }}>
            <Flame size={12} />
            희귀 의심 <span className="font-mono font-medium">{counts.rare}</span>
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          정렬 · Don't miss → 희귀 → 도착 순
        </span>
      </div>

      <div className="space-y-2">
        {unread.map(p => (
          <UnreadCard
            key={p.mrn}
            p={p}
            onSelect={(pp) => onSelect(pp, unread)}
            onAcknowledge={onAcknowledge}
          />
        ))}
      </div>
    </div>
  );
}

function UnreadCard({ p, onSelect, onAcknowledge }) {
  const top = p.preview && p.preview[0];
  const accent = p.dontMiss
    ? { c: 'var(--rl-amber)', bg: 'var(--rl-amber-soft)' }
    : p.rare
      ? { c: 'var(--rl-rare)', bg: 'var(--rl-rare-soft)' }
      : { c: 'var(--rl-primary)', bg: 'var(--rl-primary-soft)' };

  return (
    <div
      className="hairline rounded bg-white overflow-hidden flex"
      style={{ borderLeft: `3px solid ${accent.c}` }}
    >
      <div onClick={() => onSelect(p)} className="flex-1 flex items-center gap-4 px-4 py-3 cursor-pointer row-hover">
        {/* Patient identity */}
        <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: accent.bg, color: accent.c }}>
          <User size={14} />
        </div>
        <div className="min-w-0 w-44">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}>
            <BiText>{p.name}</BiText> <span className="font-normal" style={{ color: 'var(--rl-ink-2)' }}>· {p.sex}/{p.age}</span>
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>{p.mrn} · {p.time}</div>
        </div>

        {/* Top dx */}
        {top && (
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-widest mb-0.5" style={{ color: 'var(--rl-ink-3)' }}>
              Top differential
            </div>
            <div className="flex items-baseline gap-2">
              <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}><BiText>{top.name}</BiText></div>
              <div className="font-serif text-base leading-none" style={{ color: accent.c }}>
                {(top.prob * 100).toFixed(0)}<span className="text-[10px]">%</span>
              </div>
              {top.orpha && (
                <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{top.orpha}</span>
              )}
            </div>
          </div>
        )}

        {/* Flags */}
        <div className="flex items-center gap-1.5 flex-wrap" style={{ minWidth: 140 }}>
          {p.dontMiss && (
            <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
              <AlertTriangle size={10} /> Don't miss
            </span>
          )}
          {p.rare && (
            <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
              <Flame size={10} /> 희귀
            </span>
          )}
        </div>

        {/* Arrived ago */}
        <div className="text-right" style={{ minWidth: 90 }}>
          <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>도착</div>
          <div className="font-mono text-xs" style={{ color: 'var(--rl-ink-2)' }}>{p.resultAt || p.time}</div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-stretch border-l" style={{ borderColor: 'var(--rl-border-soft)' }}>
        <button
          onClick={() => onSelect(p)}
          className="px-4 text-xs font-medium flex items-center gap-1.5 hover:bg-slate-50 transition"
          style={{ color: 'var(--rl-primary)' }}
        >
          <Eye size={13} /> 결과 열기
        </button>
        <button
          onClick={() => onAcknowledge(p.mrn)}
          className="px-4 text-xs font-medium flex items-center gap-1.5 hover:bg-slate-50 transition border-l"
          style={{ color: 'var(--rl-teal)', borderColor: 'var(--rl-border-soft)' }}
          title="확인 처리"
        >
          <CheckCircle2 size={13} /> 확인
        </button>
      </div>
    </div>
  );
}

/**
 * FHIR 연결 상태 인디케이터
 * - mock 모드 (VITE_USE_MOCK!=='false') 면 칩 자체 미표시
 * - 실서버 모드면 mount 시 /metadata 1회 호출 → ok/fail
 */
function FhirStatus() {
  const useMock = import.meta.env.VITE_USE_MOCK !== 'false';
  const [state, setState] = useState({ phase: 'loading', info: null, error: null });

  useEffect(() => {
    if (useMock) return;
    let cancelled = false;
    pingFhir()
      .then(info => { if (!cancelled) setState({ phase: 'ok', info, error: null }); })
      .catch(err => { if (!cancelled) setState({ phase: 'err', info: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [useMock]);

  if (useMock) return null;

  const palette = {
    loading: { dot: 'var(--rl-ink-3)',  text: 'var(--rl-ink-3)', label: 'FHIR 확인 중' },
    ok:      { dot: 'var(--rl-teal)',   text: 'var(--rl-teal)',  label: `FHIR · ${state.info?.software || 'live'}` },
    err:     { dot: 'var(--rl-critical)', text: 'var(--rl-critical)', label: 'FHIR 연결 실패' },
  }[state.phase];

  const tooltip = state.phase === 'ok'
    ? `${state.info.url}\nFHIR ${state.info.version} · ${state.info.software}`
    : state.phase === 'err'
      ? `${state.error}\n(.env.development.local · VITE_FHIR_BASE_URL 확인)`
      : '';

  return (
    <div
      title={tooltip}
      className="flex items-center gap-1.5 px-2 py-1 rounded font-mono text-[10px] uppercase tracking-widest"
      style={{
        color: palette.text,
        background: 'transparent',
        border: '1px solid var(--rl-border-soft)',
      }}
    >
      <span className={state.phase === 'loading' ? 'pulse-dot' : ''} style={{
        width: 6, height: 6, borderRadius: '50%', background: palette.dot,
      }} />
      {palette.label}
    </div>
  );
}

function TopBar({ doctor, onLogout, activeScreen = 'worklist', onNavigate, onOpenPatient, onOpenAnnouncement }) {
  const navs = [
    { k: 'worklist',  label: '환자 목록' },
    { k: 'dashboard', label: '분석 대시보드' },
    { k: 'knowledge', label: '지식 베이스' },
    { k: 'settings',  label: '설정' },
  ];
  return (
    <div className="hairline bg-white sticky top-0 z-40" style={{ borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}>
      <div className="max-w-[1440px] mx-auto px-8 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: 'var(--rl-primary)' }}>
            <Stethoscope size={15} color="white" strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-serif text-base leading-none" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
              Soo-<span style={{ fontStyle: 'italic', fontWeight: 500 }}>Pul</span>
            </div>
            <div className="font-mono text-[10px] mt-0.5 uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
              SooNet-Pulmonary CDSS · v0.1.0
            </div>
          </div>
        </div>

        <div className="mx-4 h-6 w-px" style={{ background: 'var(--rl-border)' }} />

        <nav className="flex items-center gap-5 text-sm">
          {navs.map(n => {
            const active = activeScreen === n.k;
            return (
              <button
                key={n.k}
                onClick={() => onNavigate && onNavigate(n.k)}
                style={{
                  color: active ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
                  fontWeight: active ? 600 : 400,
                  borderBottom: active ? '2px solid var(--rl-primary)' : '2px solid transparent',
                  paddingBottom: '12px',
                  marginBottom: '-12px',
                  background: 'none',
                  cursor: 'pointer',
                  fontSize: 'inherit',
                  fontFamily: 'inherit',
                }}
              >
                {n.label}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <FhirStatus />
          <NotificationButton onOpenPatient={onOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />

          <div className="flex items-center gap-2.5 pl-3" style={{ borderLeft: '1px solid var(--rl-border)' }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
              <User size={14} />
            </div>
            <div>
              <div className="text-sm leading-none font-medium" style={{ color: 'var(--rl-ink)' }}>{doctor.name} 과장</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--rl-ink-3)' }}>
                {doctor.institution} · {doctor.department}
              </div>
            </div>
          </div>

          <SessionCountdown />

          {/* 로그아웃 — 사용 빈도 낮은 기능이라 메뉴 구석에 아이콘만 작게.
              확인 모달은 RareLinkApp 의 LogoutConfirmModal 에서 처리. */}
          <button
            onClick={onLogout}
            title="로그아웃"
            aria-label="로그아웃"
            className="flex items-center justify-center rounded transition hover:bg-slate-100"
            style={{ width: 28, height: 28, color: 'var(--rl-ink-3)' }}
          >
            <LogOut size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit, totalUnit, icon, accent, onClick, active }) {
  const colors = {
    primary: { c: 'var(--rl-primary)', bg: 'var(--rl-primary-soft)' },
    teal:    { c: 'var(--rl-teal)',    bg: 'var(--rl-teal-soft)' },
    rare:    { c: 'var(--rl-rare)',    bg: 'var(--rl-rare-soft)' },
    ink:     { c: 'var(--rl-ink-2)',   bg: 'var(--rl-bg-3)' },
  }[accent];

  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      className={`rounded bg-white p-4 flex items-center gap-4 transition ${clickable ? 'cursor-pointer hover:bg-slate-50' : ''}`}
      style={{
        border: `1px solid ${active ? colors.c : 'var(--rl-border-soft)'}`,
        borderWidth: active ? '1px' : '1px',
        boxShadow: active ? `inset 0 0 0 1px ${colors.c}` : 'none',
      }}
      title={clickable ? `${label} 필터 적용` : undefined}
    >
      <div className="w-9 h-9 rounded flex items-center justify-center" style={{ background: colors.bg, color: colors.c }}>
        {icon}
      </div>
      <div>
        <div className="text-[11px] mb-0.5 flex items-center gap-1" style={{ color: 'var(--rl-ink-3)' }}>
          {label}
          {active && <span className="font-mono text-[9px]" style={{ color: colors.c }}>· 활성</span>}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="font-serif text-2xl leading-none" style={{ color: active ? colors.c : 'var(--rl-ink)' }}>{value}</span>
          <span className="text-xs" style={{ color: 'var(--rl-ink-3)' }}>{unit}{totalUnit || ''}</span>
        </div>
      </div>
    </div>
  );
}

function PatientRow({ p, onClick, isLast, linked = false, linking = false, onLink }) {
  // 행 전체 클릭은 제거 — 텍스트 선택/복사 가능하도록.
  // 차트 진입은 우측 '열기' 링크로만, Ctrl/⌘+클릭은 ?patient=mrn 으로 새 탭.
  return (
    <div
      className="grid px-4 py-3 row-hover transition"
      style={{
        gridTemplateColumns: '68px 1.1fr 1.5fr 64px 70px 64px 130px 0.8fr 76px',
        borderBottom: isLast ? 'none' : '1px solid var(--rl-border-soft)',
        alignItems: 'center',
      }}
    >
      {/* 방문 — 진료·예약 분류 배지 + 시간 */}
      <div className="flex flex-col items-start gap-1">
        <VisitBadge cls={p.visitClass} date={p.visitDate} />
        <div className="font-mono text-[11px] font-medium" style={{ color: 'var(--rl-ink-2)' }}>
          {p.time}<span className="font-normal" style={{ color: 'var(--rl-ink-3)' }}> · {p.visit}</span>
        </div>
      </div>

      {/* Patient */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
          <User size={12} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}>
            <BiText>{p.name}</BiText> <span className="font-normal" style={{ color: 'var(--rl-ink-2)' }}>· {p.sex}/{p.age}</span>
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>{p.mrn}</div>
        </div>
      </div>

      {/* Chief complaint */}
      <div className="min-w-0 pr-3">
        <div className="text-sm truncate" style={{ color: 'var(--rl-ink)' }}><BiText>{p.complaint}</BiText></div>
        {p.allergy && (
          <div className="flex items-center gap-1 mt-0.5">
            <Ban size={10} style={{ color: 'var(--rl-critical)' }} />
            <span className="text-[11px]" style={{ color: 'var(--rl-critical)' }}>알러지 · {p.allergy}</span>
          </div>
        )}
      </div>

      {/* CXR · AI · Lab — 한눈에 상태 파악 가능하도록 독립 컬럼 3개 */}
      <StatusCell kind="cxr" value={p.cxr} />
      <StatusCell kind="ai"  value={p.status} />
      <StatusCell kind="lab" value={getLabStatus(p)} />

      {/* EMR 연동 상태 */}
      <div onClick={e => e.stopPropagation()}>
        {linked ? (
          <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--rl-teal)' }}>
            <CheckCircle2 size={13} /> 연동 완료
          </span>
        ) : linking ? (
          <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--rl-primary)' }}>
            <Loader2 size={12} className="spin" /> 연동 중…
          </span>
        ) : (
          <button
            onClick={() => onLink && onLink(p.mrn)}
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded transition hover:opacity-90"
            style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)', border: '1px solid var(--rl-amber)' }}
            title="EMR 에서 이 환자 데이터 연동"
          >
            <Database size={11} /> 연동하기
          </button>
        )}
      </div>

      {/* Flags */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {p.rare && (
          <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
            <Flame size={10} /> 희귀
          </span>
        )}
        {p.dontMiss && (
          <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
            <AlertTriangle size={10} /> Don't miss
          </span>
        )}
        {p.topDx && !p.rare && !p.dontMiss && (
          <span className="chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
            Top: {p.topDx}
          </span>
        )}
      </div>

      {/* Action — Ctrl/⌘+클릭 시 새 탭(?patient=mrn), 일반 클릭은 같은 탭 차트 진입 */}
      <div style={{ textAlign: 'right' }}>
        <a
          href={`?patient=${encodeURIComponent(p.mrn)}`}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;  // 새 탭 native 동작
            e.preventDefault();
            onClick && onClick();
          }}
          className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded transition hover:opacity-85"
          style={{
            color: 'white',
            background: 'var(--rl-primary)',
            textDecoration: 'none',
            boxShadow: '0 1px 2px rgba(12,68,124,0.18)',
          }}
          title="클릭: 차트 열기 · Ctrl/⌘+클릭: 새 탭"
        >
          열기 <ChevronRight size={13} />
        </a>
      </div>
    </div>
  );
}

/* StatusCell — CXR/AI/Lab 각각을 독립 컬럼으로 렌더 (한눈에 상태 파악).
   참조: 사용자 요구 — "CXR / AI / LAB 개별 컬럼 분리" */
const STATUS_MAPS = {
  cxr: {
    arrived: { icon: <CheckCircle2 size={11} />, label: '완료',  c: 'var(--rl-teal)' },
    pending: { icon: <Circle size={11} />,       label: '대기',  c: 'var(--rl-ink-3)' },
  },
  ai: {
    pending:   { icon: <Circle size={11} />,                  label: '대기',    c: 'var(--rl-ink-3)' },
    analyzing: { icon: <Loader2 size={11} className="spin" />, label: '분석 중', c: 'var(--rl-primary)' },
    ready:     { icon: <CheckCircle2 size={11} />,            label: '완료',    c: 'var(--rl-teal)' },
  },
  lab: {
    none:    { icon: <Circle size={11} />,                  label: '없음', c: 'var(--rl-ink-3)' },
    pending: { icon: <Loader2 size={11} className="spin" />, label: '대기', c: 'var(--rl-amber)' },
    ready:   { icon: <CheckCircle2 size={11} />,            label: '도착', c: 'var(--rl-teal)' },
  },
};
function StatusCell({ kind, value }) {
  const m = (STATUS_MAPS[kind] && STATUS_MAPS[kind][value]) || { icon: <Circle size={11} />, label: '—', c: 'var(--rl-ink-3)' };
  return (
    <div className="flex items-center gap-1 text-[11px]" style={{ color: m.c }} title={`${kind.toUpperCase()} · ${m.label}`}>
      {m.icon}<span>{m.label}</span>
    </div>
  );
}

/* ============================================================
   CHART LAYOUT · 환자 선택 시 EMR 풀스크린 차트
   ============================================================ */
function ChartLayout({ patient, list, contextLabel, onSelect, onHome, onAcknowledge, linkedMrns = new Set(), onLink }) {
  return (
    <div className="flex-1 flex" style={{ minHeight: 0 }}>
      <PatientSidebar
        list={list}
        contextLabel={contextLabel}
        selectedMrn={patient.mrn}
        onSelect={onSelect}
        onHome={onHome}
      />
      <PatientChart
        patient={patient}
        onHome={onHome}
        onAcknowledge={onAcknowledge}
        linked={linkedMrns.has(patient.mrn)}
        onLink={onLink}
      />
    </div>
  );
}

/* ----------- PATIENT SIDEBAR (resizable: 200 ~ 320 px, default 250) ----------- */
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 320;
const SIDEBAR_DEFAULT = 250;

function PatientSidebar({ list, contextLabel, selectedMrn, onSelect, onHome }) {
  const [q, setQ] = useState('');
  const [width, setWidth] = useState(SIDEBAR_DEFAULT);
  const [dragging, setDragging] = useState(false);

  const filtered = list.filter(p => {
    if (!q) return true;
    const s = q.toLowerCase();
    return p.name.toLowerCase().includes(s) || p.mrn.toLowerCase().includes(s);
  });

  // Drag-to-resize handlers · attach on window so cursor can leave the handle
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.clientX));
      setWidth(w);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const compact = width < 250;

  return (
    <aside
      className="flex flex-col bg-white relative"
      style={{
        width,
        flexShrink: 0,
        borderRight: '1px solid var(--rl-border)',
        height: 'calc(100vh - 57px)',
        position: 'sticky',
        top: 57,
      }}
    >
      {/* Header */}
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
        <button
          onClick={onHome}
          className="flex items-center gap-1.5 text-[11px] font-medium mb-2 hover:underline"
          style={{ color: 'var(--rl-primary)' }}
        >
          <Home size={12} /> 홈으로
        </button>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          Patient List
        </div>
        <div className="text-sm font-medium mt-0.5 truncate" style={{ color: 'var(--rl-ink)' }}>
          {contextLabel}
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--rl-ink-3)' }} />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="이름 / Name · MRN"
            className="pl-7 pr-3 py-1.5 rounded text-xs hairline-strong outline-none w-full focus:border-[color:var(--rl-primary)]"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map(p => (
          <SidebarPatientRow
            key={p.mrn + (p.visitDate || '')}
            p={p}
            selected={p.mrn === selectedMrn}
            compact={compact}
            onClick={() => onSelect(p)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="p-6 text-center text-xs" style={{ color: 'var(--rl-ink-3)' }}>
            결과 없음
          </div>
        )}
      </div>

      {/* Width readout (drag-only feedback) */}
      {dragging && (
        <div
          className="font-mono text-[10px] px-1.5 py-0.5 rounded"
          style={{
            position: 'absolute',
            right: 8,
            bottom: 8,
            background: 'var(--rl-primary)',
            color: 'white',
            zIndex: 60,
          }}
        >
          {width}px
        </div>
      )}

      {/* Drag handle · sits on the right edge */}
      <div
        onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
        title="드래그로 너비 조절 · 더블클릭으로 기본값(250px)"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: -3,
          width: 6,
          cursor: 'col-resize',
          zIndex: 50,
          background: dragging ? 'var(--rl-primary)' : 'transparent',
          transition: dragging ? 'none' : 'background 0.15s',
        }}
        onMouseEnter={(e) => { if (!dragging) e.currentTarget.style.background = 'var(--rl-primary-soft)'; }}
        onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = 'transparent'; }}
      />
    </aside>
  );
}

function SidebarPatientRow({ p, selected, compact, onClick }) {
  const stripe = p.dontMiss
    ? 'var(--rl-amber)'
    : p.rare
      ? 'var(--rl-rare)'
      : p.allergy
        ? 'var(--rl-critical)'
        : 'transparent';

  return (
    <div
      onClick={onClick}
      className="px-3 py-2.5 cursor-pointer transition"
      style={{
        background: selected ? 'var(--rl-primary-soft)' : 'transparent',
        borderLeft: `3px solid ${selected ? 'var(--rl-primary)' : stripe}`,
        borderBottom: '1px solid var(--rl-border-soft)',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--rl-bg-2)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Row 1 · 방문 배지 + 이름 · 성별/나이 + 미확인 dot (워크리스트 행과 동일한 VisitBadge로 통일) */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex-shrink-0">
          <VisitBadge cls={p.visitClass} date={p.visitDate} />
        </div>
        <div className="text-sm font-medium truncate flex-1 min-w-0" style={{ color: 'var(--rl-ink)' }}>
          <BiText>{p.name}</BiText> <span className="font-normal" style={{ color: 'var(--rl-ink-2)' }}>· {p.sex}/{p.age}</span>
        </div>
        {p.status === 'ready' && !p.acknowledged && (
          <span className="w-1.5 h-1.5 rounded-full pulse-dot flex-shrink-0" style={{ background: 'var(--rl-amber)' }} />
        )}
      </div>

      {/* Row 2 · MRN + flag icons */}
      <div className="flex items-center gap-2 mt-0.5 min-w-0">
        <div className="font-mono text-[10px] truncate" style={{ color: 'var(--rl-ink-3)' }}>{p.mrn}</div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {p.rare && <Flame size={9} style={{ color: 'var(--rl-rare)' }} />}
          {p.dontMiss && <AlertTriangle size={9} style={{ color: 'var(--rl-amber)' }} />}
          {p.allergy && <Ban size={9} style={{ color: 'var(--rl-critical)' }} />}
        </div>
      </div>

      {/* Row 3 · complaint (compact 모드에선 숨김) */}
      {!compact && (
        <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--rl-ink-3)' }}>
          <BiText>{p.complaint}</BiText>
        </div>
      )}
    </div>
  );
}

/* ----------- PATIENT CHART (main area · 스크롤 없이 fit) ----------- */
function PatientChart({ patient: originalPatient, onHome, onAcknowledge, linked = false, onLink }) {
  const [tab, setTab] = useState('overview');
  // 두 종류의 재분석 분리:
  //   cxrAnalyzing  · CXR 재분석 = Phase 2(CXR) → 3 → 4 → 5 → F 재실행 (이미지 + 진단)
  //   dxAnalyzing   · 진단 재분석 = Phase 3(scoring) → 4 → 5 → F (CXR 그대로)
  const [cxrAnalyzing, setCxrAnalyzing] = useState(false);
  const [dxAnalyzing,  setDxAnalyzing]  = useState(false);

  // ── EMR 정보 업데이트 (미수신 정보 재요청) ────────────────────────
  // 1) WebSocket 으로 백엔드가 push 한 환자별 신규 pending → useEmrPending
  // 2) mock 환자 객체에 미리 심긴 pendingEmrUpdates (시나리오)
  // 3) 사용자가 「정보 업데이트」 클릭으로 처리한 건수 (emrPendingDelta)
  // 표시 카운트 = (1) + (2) - (3)
  const { pending: wsPending, consume: wsConsume, wsState } = useEmrPending(originalPatient.mrn);
  const [emrState,           setEmrState]           = useState('idle'); // idle | fetching | success
  const [emrFeedback,        setEmrFeedback]        = useState(null);    // { count }
  const [emrInjectedVitals,  setEmrInjectedVitals]  = useState([]);      // 추가된 vitals 항목들 (최신순)
  const [emrPendingDelta,    setEmrPendingDelta]    = useState(0);       // 이미 처리된 pending 건수
  // 백엔드 /api/v1/patients/{mrn} 응답 (vitalsHistory, labs, cxrStudies 포함). 실패 시 null.
  const [emrDetail,          setEmrDetail]          = useState(null);
  // 시점 스냅샷 — Overview 의 시점 셀렉터 변경이 PatientChart 단일 source of truth.
  // Workspace 와 재분석 핸들러가 같은 snap 을 참조해서 "선택 시점 기준" 로 동작.
  const [snap,               setSnap]               = useState({
    cxrIdx: 0,
    vitalsIdx: 0,
    labIdx: { cbc: 0, chem: 0, abg: 0, inflam: 0 },
  });
  // 환자 바뀌면 EMR overlay + snap + tab 리셋
  // (이전 환자의 리포트 탭에 머물러 stale 화면이 보이는 문제 회피 — 항상 overview 로 시작)
  useEffect(() => {
    setEmrState('idle');
    setEmrFeedback(null);
    setEmrInjectedVitals([]);
    setEmrPendingDelta(0);
    setEmrDetail(null);
    setSnap({ cxrIdx: 0, vitalsIdx: 0, labIdx: { cbc: 0, chem: 0, abg: 0, inflam: 0 } });
    setTab('overview');
  }, [originalPatient.mrn]);

  // 환자 진입 시 백엔드에서 detail fetch (S3-backed mock EMR · HAPI proxy 로 swap 가능)
  useEffect(() => {
    let cancelled = false;
    backend.patients.get(originalPatient.mrn)
      .then((d) => {
        if (cancelled) return;
        setEmrDetail(d);
        console.info('[patient detail] loaded from /api/v1/patients/' + originalPatient.mrn);
      })
      .catch((err) => {
        console.warn('[patient detail] API failed mrn=' + originalPatient.mrn + ' status=' + (err.status || err.message));
      });
    return () => { cancelled = true; };
  }, [originalPatient.mrn]);

  // ── Workspace 진행 상태 (PatientChart 레벨에서 보존) ────────────────
  // 탭 전환에 unmount 되지 않음 → 환자 바뀌거나 재분석 누를 때만 재실행
  const [wsPhases, setWsPhases] = useState(
    Object.fromEntries(PHASE_DEFS.map(p => [p.key, 'pending']))
  );
  const [wsAttempt, setWsAttempt] = useState(0);
  const wsTimersRef = useRef([]);

  // Backend 모드 — VITE_USE_BACKEND_SESSIONS=1 일 때만 활성. 기본은 mock 시뮬레이션.
  // hook 은 항상 호출 (React rules of hooks) 하지만 USE_BACKEND_SESSIONS=false 면 호출 안 함.
  const dx = useDiagnosisSession();

  function clearWsTimers() {
    wsTimersRef.current.forEach(t => clearTimeout(t));
    wsTimersRef.current = [];
  }

  function runWsSimulation(phaseKeysToRun) {
    clearWsTimers();
    setWsPhases(prev => {
      const next = { ...prev };
      phaseKeysToRun.forEach(k => { next[k] = 'pending'; });
      return next;
    });

    const T0 = 200;
    const t = {
      p1Run: T0,              p1Done: T0 + 1500,
      p2Run: T0,              p2Done: T0 + 2000,
      p3Run: T0 + 2000,       p3Done: T0 + 2800,
      p4Run: T0 + 2800,       p4Done: T0 + 7300,
      p5Run: T0 + 2800,       p5Done: T0 + 4300,
      fRun:  T0 + 7300,       fDone:  T0 + 10800,
    };

    const schedule = [
      ['phase1', 'running',   t.p1Run],  ['phase1', 'succeeded', t.p1Done],
      ['phase2', 'running',   t.p2Run],  ['phase2', 'succeeded', t.p2Done],
      ['phase3', 'running',   t.p3Run],  ['phase3', 'succeeded', t.p3Done],
      ['phase4', 'running',   t.p4Run],  ['phase4', 'succeeded', t.p4Done],
      ['phase5', 'running',   t.p5Run],  ['phase5', 'succeeded', t.p5Done],
      ['final',  'running',   t.fRun ],  ['final',  'succeeded', t.fDone ],
    ].filter(([k]) => phaseKeysToRun.includes(k));

    schedule.forEach(([key, state, when]) => {
      const tid = setTimeout(() => {
        setWsPhases(prev => ({ ...prev, [key]: state }));
      }, when);
      wsTimersRef.current.push(tid);
    });
  }

  function startBackendDiagnosis() {
    dx.start({
      patient_fhir_id: originalPatient.mrn,
      symptom_text: originalPatient.complaint || '',
      cxr_s3_key: originalPatient.cxrStudies?.[0]?.studyId || null,
    });
  }

  // 환자 바뀌면 attempt 만 초기화한다.
  // 진단 시작(backend dx.start / mock 시뮬레이션)은 triggerAutoDx 가 단독으로
  // 담당한다 — 연동된 환자는 emrStage=6 effect, 미연동 환자는 handleEmrLoad 가 호출.
  // (과거: 여기서도 startBackendDiagnosis 를 직접 호출 → triggerAutoDx 와 중복돼
  //  세션·폴링 루프가 2개 생성되고 phase3·4·RAG 결과가 깜빡이는 버그가 있었음.)
  useEffect(() => {
    setWsAttempt(1);
    return clearWsTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalPatient.mrn]);

  // Backend 모드일 때 dx.phases 를 wsPhases 로 미러링 (UI는 wsPhases 만 봄)
  useEffect(() => {
    if (USE_BACKEND_SESSIONS) {
      setWsPhases(dx.phases);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dx.phases]);

  // ─── 리포트 상태 (탭 알림 + RAG 패널 "전체 본문 보기" 버튼) ───
  // backend 모드: dx.result 있고 phases.final='succeeded' 이면 'ready'
  // mock 모드:    wsPhases.final='succeeded' 이면 'ready'
  const finalReportData = USE_BACKEND_SESSIONS ? (dx.result || null) : null;
  const reportState =
    wsPhases.final === 'running' ? 'generating'
    : wsPhases.final === 'succeeded' && (!USE_BACKEND_SESSIONS || finalReportData) ? 'ready'
    : 'idle';

  // ─── 진단 상태 (Overview 감별진단 패널 — 분석 전/중/완료 일관 표시) ───
  //   pending : 진단 미시작 / running : 진행 중 / done : Phase 4(감별진단)까지 완료
  const dxState = (() => {
    const vals = Object.values(wsPhases);
    if (wsPhases.phase4 === 'succeeded') return 'done';
    if (vals.some(s => s === 'running' || s === 'succeeded')) return 'running';
    return 'pending';
  })();

  // ─── EMR 데이터 연동 ──────────────────────────────────────
  // 미연동 환자 (linked=false) 진입 시 화면 위에 EMR 연동 overlay 표시.
  //   "EMR 에서 불러오기" 클릭 → 5단계 progressive (basic/vitals/labs/cxr/notes)
  //   → onLink(mrn) 으로 워크리스트 연동 상태 반영 → overlay 사라지고 Overview.
  // demo 모드 (?demo=1): 5단계 완료 후 자동 진단까지 시작. 일반 모드: 연동만.
  // 이미 연동된 환자 (linked=true): overlay 스킵 → 바로 Overview.
  const isDemoMode = (() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get('demo');
      return v === '1' || v === 'true';
    } catch (_) { return false; }
  })();
  // emrStage: 0=대기 / 1=basic / 2=+vitals / 3=+labs / 4=+cxr / 5=+notes / 6=완료
  const [emrStage, setEmrStage] = useState(linked ? 6 : 0);
  const emrTimersRef = useRef([]);
  // emrStage 는 React state 라 비동기 — 빠른 연속 클릭/리렌더 시 두 호출이 모두
  // emrStage=0 을 보고 통과해 진단 session 이 중복 생성될 수 있다. ref 로 동기 가드.
  const emrLoadStartedRef = useRef(false);
  // 자동 진단 1회 가드 — "데이터 들어온(연동된) 환자 = 분석 완료" 정책.
  const autoDxRef = useRef(false);
  function clearEmrTimers() {
    emrTimersRef.current.forEach(t => clearTimeout(t));
    emrTimersRef.current = [];
  }

  // 연동된 환자는 진입/연동 시점에 진단을 자동 1회 실행한다 — Overview·워크스페이스·
  // 리포트가 모두 같은 진단 결과를 공유하도록. (미연동 환자는 EMR overlay 단계)
  function triggerAutoDx() {
    if (autoDxRef.current) return;
    autoDxRef.current = true;
    const payload = {
      patient_fhir_id: originalPatient.mrn,
      symptom_text: originalPatient.complaint || '호흡곤란 · 마른기침 · 체중감소',
      cxr_s3_key: null,
    };
    if (USE_BACKEND_SESSIONS) {
      try { dx.start(payload); } catch (e) { console.warn('[auto-dx]', e); }
    } else {
      runWsSimulation(PHASE_DEFS.map(p => p.key));
    }
  }

  // 환자 바뀌면 — 연동 여부에 따라 overlay (미연동) 또는 스킵 (연동완료)
  useEffect(() => {
    clearEmrTimers();
    emrLoadStartedRef.current = false;
    autoDxRef.current = false;
    setEmrStage(linked ? 6 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalPatient.mrn, linked]);

  // 이미 연동된 환자 진입 시 자동 진단 (미연동 환자는 handleEmrLoad 가 처리)
  useEffect(() => {
    if (linked && emrStage === 6) triggerAutoDx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalPatient.mrn, linked, emrStage]);

  function handleEmrLoad() {
    if (emrLoadStartedRef.current || emrStage > 0) return;
    emrLoadStartedRef.current = true;
    clearEmrTimers();
    setEmrStage(1);  // basic info — backend useEffect 가 이미 fetch 트리거함
    [2, 3, 4, 5, 6].forEach((s, i) => {
      const t = setTimeout(() => {
        setEmrStage(s);
        if (s === 6) {
          // 연동 완료 → 워크리스트 linkedMrns 반영 + 자동 진단 (연동 환자 = 분석 완료)
          try { onLink?.(originalPatient.mrn); } catch (_) {}
          const t2 = setTimeout(() => {
            triggerAutoDx();
            if (isDemoMode) setTab('workspace');  // demo 만 워크스페이스로 자동 이동 (시연)
          }, 500);
          emrTimersRef.current.push(t2);
        }
      }, (i + 1) * 500);
      emrTimersRef.current.push(t);
    });
  }

  function handleEmrReset() {
    clearEmrTimers();
    clearWsTimers();
    emrLoadStartedRef.current = false;
    autoDxRef.current = false;
    setEmrStage(0);
    setWsPhases(Object.fromEntries(PHASE_DEFS.map(p => [p.key, 'pending'])));
    setWsAttempt(0);
    try { dx.stop?.(); } catch (_) {}
    setTab('overview');
  }

  function wsRerunAll() {
    logSnap('workspace-rerun-all');
    setWsAttempt(a => a + 1);
    if (USE_BACKEND_SESSIONS) {
      dx.rerun ? dx.rerun() : startBackendDiagnosis();
    } else {
      runWsSimulation(['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'final']);
    }
  }
  function wsRerunImage() {
    logSnap('workspace-rerun-image');
    setWsAttempt(a => a + 1);
    // Backend 는 부분 재실행 지원 안 함 — 전체 rerun 으로 대체
    if (USE_BACKEND_SESSIONS) {
      dx.rerun ? dx.rerun() : startBackendDiagnosis();
    } else {
      runWsSimulation(['phase2', 'phase3', 'phase4', 'phase5', 'final']);
    }
  }
  function wsRerunRare() {
    logSnap('workspace-rerun-rare');
    setWsAttempt(a => a + 1);
    if (USE_BACKEND_SESSIONS) {
      dx.rerun ? dx.rerun() : startBackendDiagnosis();
    } else {
      runWsSimulation(['phase5', 'final']);
    }
  }

  // EMR 미수신 카운트 = (mock 시나리오 초기값) + (WS 누적) - (이미 처리한 건수)
  const pendingEmrCount = Math.max(
    0,
    Number(originalPatient.pendingEmrUpdates || 0) + wsPending - emrPendingDelta
  );

  // 베이스 = original + 백엔드에서 받은 detail (vitalsHistory, labs, cxrStudies 포함)
  // 백엔드 /patients/{mrn} 응답이 visitDate/visitClass 등 워크리스트 단계의
  // 주입 필드를 덮어쓰지 않도록 명시적으로 보존 (chart 배너와 사이드바·워크리스트
  // 방문 배지가 같은 날짜를 표시해야 매치됨).
  const baseFromEmr = {
    ...originalPatient,
    ...(emrDetail || {}),
    visitDate:  originalPatient.visitDate  ?? (emrDetail && emrDetail.visitDate)  ?? undefined,
    visitClass: originalPatient.visitClass ?? (emrDetail && emrDetail.visitClass) ?? undefined,
  };

  // EMR 업데이트로 추가된 vitals 를 baseline 위에 prepend → VitalsSection 이 정렬해서 사용
  const baseVitalsHistory = Array.isArray(baseFromEmr.vitalsHistory) && baseFromEmr.vitalsHistory.length > 0
    ? baseFromEmr.vitalsHistory
    : null;
  const overlayVitalsHistory = emrInjectedVitals.length > 0
    ? (baseVitalsHistory
        ? [...emrInjectedVitals, ...baseVitalsHistory]
        : [...emrInjectedVitals]) // baseline 없으면 normalize 가 default 와 머지함
    : null;

  // patient에 플래그 + EMR overlay 주입 — 자식 컴포넌트가 visual 분기에 사용
  const patient = {
    ...baseFromEmr,
    cxrAnalyzing,
    dxAnalyzing,
    pendingEmrUpdates: pendingEmrCount,
    ...(overlayVitalsHistory ? { vitalsHistory: overlayVitalsHistory } : {}),
  };

  function handleEmrUpdate() {
    if (emrState === 'fetching') return;
    setEmrState('fetching');
    setEmrFeedback(null);
    setTimeout(() => {
      // mock fetch 결과: 새 vitals entry 한 건 (현재 시각, 기존 최신값을 약간 변동)
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const tzOffsetMin = -now.getTimezoneOffset();
      const tzSign = tzOffsetMin >= 0 ? '+' : '-';
      const tzAbs = Math.abs(tzOffsetMin);
      const tzStr = `${tzSign}${pad(Math.floor(tzAbs / 60))}:${pad(tzAbs % 60)}`;
      const isoLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${tzStr}`;

      const baseHist = normalizeVitalsHistory(originalPatient);
      const baseVital = baseHist[0]?.vitals
        || 'BP 130/80 · HR 84 · RR 18 · SpO₂ 96% (RA) · T 36.7°C';

      const fresh = { measuredAt: isoLocal, vitals: baseVital };

      // 처리할 건수: pending 이 있으면 그만큼, 없으면 기본 1
      const consumed = Math.max(1, pendingEmrCount);

      setEmrInjectedVitals((prev) => [fresh, ...prev]);
      setEmrPendingDelta((prev) => prev + consumed);
      // WS 누적 pending 도 클리어 (Context 측에서 0 으로)
      wsConsume();
      setEmrState('success');
      setEmrFeedback({ count: consumed });

      // 2.2초 후 idle 복귀
      setTimeout(() => {
        setEmrState('idle');
        setEmrFeedback(null);
      }, 2200);
    }, 1500);
  }

  function logSnap(action) {
    // 어떤 시점 데이터가 분석에 들어가는지 콘솔에 명시 — 데모 가시성용.
    // production 에선 backend POST body 에 같은 정보 포함해서 audit 로 기록.
    const cxrAt    = patient.cxrStudies?.[snap.cxrIdx]?.capturedAt;
    const vitalsAt = patient.vitalsHistory?.[snap.vitalsIdx]?.measuredAt;
    const labCats  = ['cbc', 'chem', 'abg', 'inflam'];
    const labAts   = Object.fromEntries(labCats.map(c => {
      const panel = (patient.labs || {})[c]?.[snap.labIdx[c]];
      return [c, panel?.resultedAt || panel?.collectedAt || null];
    }));
    console.info('[reanalyze] action=' + action + ' mrn=' + patient.mrn, {
      cxrCapturedAt:   cxrAt,
      vitalsMeasuredAt: vitalsAt,
      labResultedAt:   labAts,
    });
  }

  function handleReanalyzeCxr() {
    logSnap('full-reanalyze (CXR + DX)');
    setCxrAnalyzing(true);
    setDxAnalyzing(true); // CXR 결과가 바뀌면 ranking도 다시 (데이터 의존성)
    setTimeout(() => {
      setCxrAnalyzing(false);
      setDxAnalyzing(false);
    }, 5000);
  }

  function handleReanalyzeDx() {
    logSnap('dx-reanalyze');
    setDxAnalyzing(true); // 진단만 — CXR overlay 안 띄움
    setTimeout(() => setDxAnalyzing(false), 3000);
  }

  // 확대보기 팝업 → 부모 창으로 CXR 재분석 메시지 수신
  useEffect(() => {
    function onMessage(e) {
      if (e.data?.type === 'rare-link:reanalyze-cxr') handleReanalyzeCxr();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div
      className="flex-1 flex flex-col"
      style={{ minWidth: 0, height: 'calc(100vh - 57px)', overflow: 'hidden', position: 'relative' }}
    >
      {/* EMR 연동 overlay — 미연동 환자 (emrStage < 6) 일 때 표시 */}
      {emrStage < 6 && (
        <EmrLoadOverlay
          patient={originalPatient}
          stage={emrStage}
          onLoad={handleEmrLoad}
          onReset={handleEmrReset}
        />
      )}
      {/* DEMO 모드 시연 리셋 버튼 — 연동 완료 (emrStage===6) 후 우상단 표시.
          반복 시연용이라 demo 모드에서만 노출. */}
      {isDemoMode && emrStage === 6 && (
        <button
          onClick={handleEmrReset}
          className="absolute top-2 right-4 z-20 flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium rounded shadow-sm hover:opacity-90"
          style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)', border: '1px solid var(--rl-amber)' }}
          title="EMR 연동 시연 처음으로 — 모든 데이터 비우고 다시"
        >
          <RefreshCw size={11} /> 시연 리셋
        </button>
      )}
      <PatientBanner
        patient={patient}
        onHome={onHome}
        onAcknowledge={onAcknowledge}
        onReanalyzeAll={handleReanalyzeCxr}
        onEmrUpdate={handleEmrUpdate}
        emrState={emrState}
        emrFeedback={emrFeedback}
      />
      <ChartTabs active={tab} onChange={setTab} patient={patient} reportState={reportState} />

      {/* Tab content · viewport에 맞게 fit */}
      <div className="flex-1 px-6 py-4" style={{ minHeight: 0, overflow: 'hidden' }}>
        {tab === 'overview'  && <ChartOverview patient={patient} snap={snap} onSnapChange={setSnap} onReanalyzeCxr={handleReanalyzeCxr} onReanalyzeDx={handleReanalyzeDx} dxState={dxState} />}
        {tab === 'cxr'       && <ChartCXR patient={patient} snap={snap} onReanalyze={handleReanalyzeCxr} />}
        {tab === 'workspace' && (
          <ChartWorkspace
            patient={patient}
            snap={snap}
            phases={wsPhases}
            attempt={wsAttempt}
            onRerunAll={wsRerunAll}
            onRerunImage={wsRerunImage}
            onRerunRare={wsRerunRare}
            phase5Result={USE_BACKEND_SESSIONS ? dx.session?.phase5 : null}
            finalReport={finalReportData}
            reportState={reportState}
          />
        )}
        {tab === 'report'    && (
          <ChartReport
            patient={patient}
            finalReport={finalReportData}
            reportState={reportState}
            phase3={USE_BACKEND_SESSIONS ? dx.session?.phase3 : null}
            phase5={USE_BACKEND_SESSIONS ? dx.session?.phase5 : null}
          />
        )}
        {tab === 'history'   && <ChartHistory patient={patient} />}
      </div>

      {/* HITL footer · 항상 하단 고정 */}
      <div className="px-6 py-2 text-[11px] flex items-start gap-2 flex-shrink-0" style={{ background: 'var(--rl-amber-soft)', borderTop: '1px solid var(--rl-amber)' }}>
        <AlertTriangle size={12} style={{ color: 'var(--rl-amber)', marginTop: 1, flexShrink: 0 }} />
        <div style={{ color: 'var(--rl-ink-2)' }}>
          <span className="font-medium" style={{ color: 'var(--rl-amber)' }}>본 시스템의 모든 AI 분석 결과는 진단 보조용입니다.</span>{' '}
          환자에 대한 최종 진단 및 치료 결정은 반드시 주치의의 임상적 판단에 따라야 합니다.
          <span className="font-mono ml-2" style={{ color: 'var(--rl-ink-3)' }}>[EU AI Act Art. 22]</span>
        </div>
      </div>
    </div>
  );
}

/* ----------- PATIENT BANNER (flex 자식, 항상 상단 고정) ----------- */
function PatientBanner({
  patient,
  onHome,
  onAcknowledge,
  onReanalyzeAll,
  onEmrUpdate,
  emrState = 'idle',
  emrFeedback = null,
}) {
  const isUnread = patient.status === 'ready' && !patient.acknowledged;
  const analyzing = patient.cxrAnalyzing || patient.dxAnalyzing;
  return (
    <div
      className="bg-white"
      style={{ borderBottom: '1px solid var(--rl-border)', flexShrink: 0 }}
    >
      <div className="px-6 py-2.5 flex items-center gap-3 flex-wrap">
        <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--rl-primary)', color: 'white' }}>
          <User size={18} />
        </div>

        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <BiText
              as="div"
              serif
              className="font-serif text-xl leading-none"
              style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}
            >
              {patient.name}
            </BiText>
            <div className="text-sm" style={{ color: 'var(--rl-ink-2)' }}>
              {patient.sex === 'M' ? '남' : '여'} · {patient.age}세
            </div>
            <div className="font-mono text-xs" style={{ color: 'var(--rl-ink-3)' }}>· {patient.mrn}</div>
          </div>
          <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>
            {/* 워크리스트·사이드바와 동일한 VisitBadge — 날짜 표기 일관성 */}
            <VisitBadge cls={patient.visitClass} date={patient.visitDate} />
            <span className="flex items-center gap-1">
              <CalendarDays size={11} /> {patient.visitDate || liveDateLabel()} · {patient.time}
            </span>
            <span>· {patient.visit}</span>
          </div>
        </div>

        {/* Flags strip */}
        <div className="flex items-center gap-1.5 ml-4 flex-wrap">
          {patient.allergy && (
            <span className="chip" style={{ background: 'var(--rl-critical-soft)', color: 'var(--rl-critical)' }}>
              <Ban size={11} /> 알러지 · {patient.allergy}
            </span>
          )}
          {patient.dontMiss && (
            <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
              <AlertTriangle size={11} /> Don't miss
            </span>
          )}
          {patient.rare && (
            <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
              <Flame size={11} /> 희귀질환 의심
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {onReanalyzeAll && (
            <ReanalyzeAllButton onClick={onReanalyzeAll} analyzing={analyzing} />
          )}
          {onEmrUpdate && (
            <EmrUpdateButton
              onClick={onEmrUpdate}
              state={emrState}
              pendingCount={patient.pendingEmrUpdates || 0}
              feedback={emrFeedback}
            />
          )}
          {isUnread && (
            <button
              onClick={() => onAcknowledge(patient.mrn)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium hover:opacity-90"
              style={{ background: 'var(--rl-teal)', color: 'white' }}
            >
              <CheckCircle2 size={12} /> 결과 확인 처리
            </button>
          )}
          <button
            onClick={onHome}
            className="p-1.5 rounded hover:bg-slate-100"
            style={{ color: 'var(--rl-ink-2)' }}
            title="홈으로"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------- CHART TABS ----------- */
function ChartTabs({ active, onChange, patient, reportState = 'idle' }) {
  // 리포트 탭: 'idle' → 미생성 / 'generating' → 생성중 / 'ready' → 빨간 점 알림
  const reportLabel =
    reportState === 'generating' ? '리포트 (생성중)'
    : reportState === 'ready'    ? '리포트'
                                 : '리포트 (미생성)';
  const tabs = [
    { k: 'overview',  label: 'Overview',           icon: <Eye size={13} /> },
    { k: 'cxr',       label: 'CXR · AI',           icon: <ScanLine size={13} /> },
    { k: 'workspace', label: '진단 워크스페이스',  icon: <Microscope size={13} />, badge: 'W3' },
    {
      k: 'report',
      label: reportLabel,
      icon: <FileText size={13} />,
      dot: reportState === 'ready',        // 새 RAG 생성 알림 빨간 점
      muted: reportState !== 'ready',      // 미생성/생성중 일 때 dim
    },
    { k: 'history',   label: '히스토리',           icon: <Clock size={13} /> },
  ];
  return (
    <div className="bg-white px-6" style={{
      borderBottom: '1px solid var(--rl-border-soft)',
      flexShrink: 0,
    }}>
      <div className="flex items-center gap-1">
        {tabs.map(t => {
          const isActive = active === t.k;
          const color = isActive ? 'var(--rl-primary)'
                      : t.muted   ? 'var(--rl-ink-3)'
                                  : 'var(--rl-ink-2)';
          return (
            <button
              key={t.k}
              onClick={() => onChange(t.k)}
              className="px-4 py-3 text-xs font-medium flex items-center gap-1.5 transition relative"
              style={{
                color,
                borderBottom: `2px solid ${isActive ? 'var(--rl-primary)' : 'transparent'}`,
                marginBottom: '-1px',
              }}
            >
              {t.icon}
              {t.label}
              {t.badge && (
                <span className="font-mono text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--rl-bg-3)', color: 'var(--rl-ink-3)' }}>
                  {t.badge}
                </span>
              )}
              {t.dot && (
                <span
                  title="새 리포트 생성됨"
                  style={{
                    display: 'inline-block',
                    width: 8, height: 8, borderRadius: '50%',
                    background: 'var(--rl-critical)',
                    marginLeft: 2,
                    boxShadow: '0 0 0 2px white, 0 0 0 3px var(--rl-critical-soft)',
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----------- CHART OVERVIEW · 객관적 환자 정보 + Lab + CXR + Top 3 ----------- */
function ChartOverview({ patient, snap, onSnapChange, onReanalyzeCxr, onReanalyzeDx, dxState = 'pending' }) {
  const top3 = (patient.preview || []).slice(0, 3);
  const [cxrView, setCxrView] = useState('original');
  const cxrAnalyzing = patient.cxrAnalyzing === true;
  const dxAnalyzing  = patient.dxAnalyzing  === true;
  const cxrStudies = normalizeCxrStudies(patient);
  // controlled — 시점은 PatientChart 의 snap.cxrIdx 가 single source of truth
  const cxrIdx = snap?.cxrIdx ?? 0;
  const setCxrIdx = (i) => onSnapChange({ ...snap, cxrIdx: i });
  // vitals/lab 시점도 같은 패턴
  const vitalsIdx = snap?.vitalsIdx ?? 0;
  const setVitalsIdx = (i) => onSnapChange({ ...snap, vitalsIdx: i });
  const setLabIdx = (cat, i) => onSnapChange({ ...snap, labIdx: { ...snap.labIdx, [cat]: i } });

  return (
    <div
      className="grid gap-3 fade-in h-full"
      style={{ gridTemplateColumns: 'minmax(0, 0.85fr) minmax(0, 1.4fr) minmax(0, 1fr)' }}
    >
      {/* 좌: 객관적 환자 정보 + 바이탈 + Lab */}
      <Panel title="환자 정보" mono="Demographics" fill>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          <InfoCell label="나이 · 성별" value={`${patient.sex === 'M' ? '남' : '여'} · ${patient.age}세`} compact />
          <InfoCell label="MRN"          value={patient.mrn} mono compact />
          <InfoCell label="방문 유형"    value={patient.visit} compact />
          <InfoCell label="알러지"       value={patient.allergy || '—'} compact />
          <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
            <InfoCell
              label="방문 일시"
              value={`${patient.visitDate || '2026-04-23'} ${patient.time || '08:30'}:00`}
              mono
              compact
            />
          </div>
        </div>
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--rl-border-soft)' }}>
          <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-ink-3)' }}>주호소 · Chief complaint</div>
          <div className="text-sm leading-relaxed t-bilingual" style={{ color: 'var(--rl-ink)' }}><BiText>{patient.complaint}</BiText></div>
        </div>
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--rl-border-soft)' }}>
          <VitalsSection patient={patient} idx={vitalsIdx} onIdxChange={setVitalsIdx} />
        </div>
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--rl-border-soft)' }}>
          <LabSection patient={patient} labIdx={snap?.labIdx} onLabIdxChange={setLabIdx} />
        </div>
      </Panel>

      {/* 중: CXR */}
      <Panel
        title="CXR · Chest X-ray"
        mono="Frontal"
        fill
        right={
          <div className="flex items-center gap-2">
            <CxrViewToggle view={cxrView} onChange={setCxrView} />
            <button
              onClick={() => openCxrPopup(patient, cxrStudies[cxrIdx])}
              className="text-[11px] font-medium flex items-center gap-1 hover:underline"
              style={{ color: 'var(--rl-primary)' }}
            >
              확대 보기 <ArrowUpRight size={11} />
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
          {/* 촬영 일시 선택 + 이 시점 재분석 (셀렉터 옆) */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TimePointSelect
                items={cxrStudies.map(s => ({
                  stamp: s.capturedAt,
                  sub: `${s.modality} · ${s.view} · ${s.studyId}`,
                }))}
                selectedIdx={cxrIdx}
                onSelect={setCxrIdx}
                label="촬영 일시"
                icon={ScanLine}
                noMargin
              />
            </div>
            <ReanalyzeButton
              onClick={onReanalyzeCxr}
              disabled={cxrAnalyzing}
              label="이 시점 재분석"
            />
          </div>
          <div
            className="hairline-strong rounded"
            style={{ background: '#0A1628', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
          >
            {/* 재분석 중에도 CXR 본 이미지·heatmap 은 그대로 유지하고 배지만 우측 상단에 표시 */}
            {cxrAnalyzing && <CxrAnalyzingOverlay />}
            {patient.cxr !== 'arrived' ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <ScanLine size={32} style={{ color: 'rgba(255,255,255,0.3)', margin: '0 auto 8px' }} />
                  <div className="font-mono text-[11px] uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.5)' }}>촬영 대기 중</div>
                </div>
              </div>
            ) : cxrView === 'heatmap' ? (
              // Heatmap 3-state — CXR 탭과 완전 동일 (분석 정보 없음 / 이상 없음 /
              // 최고 % label 초점 heatmap). 같은 시점(cxrIdx)·같은 label 초점.
              (() => {
                if (patient.status !== 'ready') return <CxrHeatmapState kind="none" />;
                const positives = deriveChexpertLabels(patient).filter(l => l.score >= 0.5);
                if (!positives.length) return <CxrHeatmapState kind="normal" />;
                const topLabel = positives[0].name;
                return <CxrViewer study={cxrStudies[cxrIdx]} heatmap={true}
                  focalRegions={LABEL_FOCAL_REGIONS[topLabel] || null} labelName={topLabel} />;
              })()
            ) : (
              <CxrViewer
                study={cxrStudies[cxrIdx]}
                heatmap={false}
              />
            )}
          </div>
        </div>
      </Panel>

      {/* 우: 감별진단 순위 (Phase 3·4) + 희귀질환 listing (Phase 5) — 분리 표시 */}
      <Panel
        title="감별진단 · 희귀질환"
        mono="Phase 3·4 ranking + Phase 5 listing"
        fill
        right={<ReanalyzeButton onClick={onReanalyzeDx} disabled={dxAnalyzing} label="진단 재분석" />}
      >
        {dxAnalyzing ? (
          <div className="rounded h-full flex flex-col items-center justify-center text-sm gap-2" style={{ color: 'var(--rl-primary)', background: 'var(--rl-primary-soft)' }}>
            <Loader2 size={18} className="spin" />
            <div>진단 재계산 진행 중…</div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>
              평균 약 60초 소요
            </div>
          </div>
        ) : dxState === 'done' && top3.length > 0 ? (
          <DxRankingSplit patient={patient} top3={top3} />
        ) : dxState === 'running' ? (
          <div className="rounded h-full flex flex-col items-center justify-center text-sm gap-2" style={{ color: 'var(--rl-primary)', background: 'var(--rl-primary-soft)' }}>
            <Loader2 size={16} className="spin" />
            <div>AI 분석 진행 중…</div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>
              Phase 1~4 · 감별진단 산출 중
            </div>
          </div>
        ) : (
          <div className="rounded h-full flex flex-col items-center justify-center text-sm gap-1.5" style={{ color: 'var(--rl-ink-3)', background: 'var(--rl-bg-2)' }}>
            <Microscope size={18} />
            <div>AI 분석 대기 중</div>
            <div className="font-mono text-[10px]">EMR 연동 완료 시 자동 분석됩니다</div>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ----------- 감별진단 순위 (Phase 3·4) ↔ 희귀질환 listing (Phase 5) 분리 -----------
 * 일반/기타 질환: Phase 3 다중모달 가중 스코어링 + Phase 4 LLM rerank → "통합 스코어"
 *                (Likelihood Ratio 아님 — LR 용어 사용 금지)
 * 희귀질환:       Phase 5 LIRICAL Likelihood Ratio listing → "LR" 용어 사용
 * --------------------------------------------------------------------------------- */
function DxRankingSplit({ patient, top3 }) {
  const commonDx = top3.filter(d => !d.rare);
  const rareDx   = top3.filter(d => d.rare);
  return (
    <div className="space-y-3">
      {/* 일반·기타 질환 — Phase 3·4 ranking */}
      <div>
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className="text-[11px] font-medium" style={{ color: 'var(--rl-primary)' }}>
            감별진단 순위
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
            Phase 3·4 · 다중모달 통합 스코어
          </span>
        </div>
        {commonDx.length > 0 ? (
          <div className="space-y-2">
            {commonDx.map((dx, i) => (
              <DxPreviewRow
                key={`c${i}`}
                rank={i + 1}
                {...dx}
                kind="ranking"
                onClick={() => openDxEvidencePopup(patient, dx, i + 1)}
              />
            ))}
          </div>
        ) : (
          <div className="text-[11px] py-2 px-3 rounded" style={{ color: 'var(--rl-ink-3)', background: 'var(--rl-bg-2)' }}>
            해당 없음
          </div>
        )}
      </div>

      {/* 희귀질환 — Phase 5 LIRICAL LR listing */}
      <div>
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className="text-[11px] font-medium" style={{ color: 'var(--rl-rare)' }}>
            희귀질환 listing
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
            Phase 5 · LIRICAL Likelihood Ratio
          </span>
        </div>
        {rareDx.length > 0 ? (
          <div className="space-y-2">
            {rareDx.map((dx, i) => (
              <DxPreviewRow
                key={`r${i}`}
                rank={i + 1}
                {...dx}
                kind="rare"
                onClick={() => openDxEvidencePopup(patient, dx, i + 1)}
              />
            ))}
          </div>
        ) : (
          <div className="text-[11px] py-2 px-3 rounded" style={{ color: 'var(--rl-ink-3)', background: 'var(--rl-bg-2)' }}>
            LIRICAL LR 임계 (&gt; 5) 를 만족하는 희귀질환 없음
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------- LAB SECTION · 카테고리 탭 + 결과 테이블 ----------- */
const DEFAULT_VITALS = 'BP 130/80 · HR 84 · RR 18 · SpO₂ 96% (RA) · T 36.7°C';

/* ----------- LAB · 시점별(panel) 데이터 ----------------------
 * EMR 표준에선 검사마다 검체 채취(collectedAt) 와 결과 보고(resultedAt)
 * 시각이 메타데이터로 함께 저장됨 (FHIR Observation.effective[x] / .issued).
 * 따라서 한 카테고리에 여러 시점의 패널을 보관하고, UI 에서 검사 시점을
 * 선택할 수 있게 한다. 디폴트는 항상 최신(panels[0]).
 * --------------------------------------------------------------- */
const DEFAULT_LAB_PANELS = {
  cbc: [
    {
      collectedAt: '2026-04-23T07:42:18+09:00',
      resultedAt:  '2026-04-23T08:55:42+09:00',
      rows: [
        { name: 'WBC',          value: '7.4',  unit: '×10⁹/L', range: '4.0–10.0', flag: null },
        { name: 'Hb',           value: '13.8', unit: 'g/dL',   range: '13.0–17.0', flag: null },
        { name: 'Hct',          value: '41.2', unit: '%',      range: '40–52',    flag: null },
        { name: 'Plt',          value: '245',  unit: '×10⁹/L', range: '150–400',  flag: null },
        { name: 'Lymphocyte',   value: '1.8',  unit: '×10⁹/L', range: '1.0–4.0',  flag: null },
        { name: 'Neutrophil%',  value: '62.1', unit: '%',      range: '40–75',    flag: null },
        { name: 'Eosinophil%',  value: '2.4',  unit: '%',      range: '0–7',      flag: null },
      ],
    },
    {
      collectedAt: '2026-04-09T08:14:33+09:00',
      resultedAt:  '2026-04-09T09:28:11+09:00',
      rows: [
        { name: 'WBC',          value: '8.1',  unit: '×10⁹/L', range: '4.0–10.0', flag: null },
        { name: 'Hb',           value: '13.4', unit: 'g/dL',   range: '13.0–17.0', flag: null },
        { name: 'Hct',          value: '40.6', unit: '%',      range: '40–52',    flag: null },
        { name: 'Plt',          value: '232',  unit: '×10⁹/L', range: '150–400',  flag: null },
        { name: 'Lymphocyte',   value: '1.6',  unit: '×10⁹/L', range: '1.0–4.0',  flag: null },
        { name: 'Neutrophil%',  value: '64.8', unit: '%',      range: '40–75',    flag: null },
        { name: 'Eosinophil%',  value: '2.7',  unit: '%',      range: '0–7',      flag: null },
      ],
    },
    {
      collectedAt: '2026-03-12T07:55:08+09:00',
      resultedAt:  '2026-03-12T09:08:55+09:00',
      rows: [
        { name: 'WBC',          value: '6.9',  unit: '×10⁹/L', range: '4.0–10.0', flag: null },
        { name: 'Hb',           value: '13.6', unit: 'g/dL',   range: '13.0–17.0', flag: null },
        { name: 'Hct',          value: '40.9', unit: '%',      range: '40–52',    flag: null },
        { name: 'Plt',          value: '258',  unit: '×10⁹/L', range: '150–400',  flag: null },
        { name: 'Lymphocyte',   value: '2.0',  unit: '×10⁹/L', range: '1.0–4.0',  flag: null },
        { name: 'Neutrophil%',  value: '60.4', unit: '%',      range: '40–75',    flag: null },
        { name: 'Eosinophil%',  value: '2.2',  unit: '%',      range: '0–7',      flag: null },
      ],
    },
  ],
  chem: [
    {
      collectedAt: '2026-04-23T07:42:18+09:00',
      resultedAt:  '2026-04-23T09:02:14+09:00',
      rows: [
        { name: 'BUN',     value: '14',    unit: 'mg/dL',  range: '8–20',     flag: null },
        { name: 'Cr',      value: '0.92',  unit: 'mg/dL',  range: '0.7–1.3',  flag: null },
        { name: 'eGFR',    value: '88',    unit: 'mL/min', range: '≥60',      flag: null },
        { name: 'Na',      value: '139',   unit: 'mmol/L', range: '136–145',  flag: null },
        { name: 'K',       value: '4.2',   unit: 'mmol/L', range: '3.5–5.0',  flag: null },
        { name: 'AST',     value: '24',    unit: 'U/L',    range: '10–40',    flag: null },
        { name: 'ALT',     value: '21',    unit: 'U/L',    range: '10–40',    flag: null },
        { name: 'Glucose', value: '102',   unit: 'mg/dL',  range: '70–110',   flag: null },
        { name: 'BNP',     value: '38',    unit: 'pg/mL',  range: '<100',     flag: null },
      ],
    },
    {
      collectedAt: '2026-04-09T08:14:33+09:00',
      resultedAt:  '2026-04-09T09:35:48+09:00',
      rows: [
        { name: 'BUN',     value: '16',    unit: 'mg/dL',  range: '8–20',     flag: null },
        { name: 'Cr',      value: '0.95',  unit: 'mg/dL',  range: '0.7–1.3',  flag: null },
        { name: 'eGFR',    value: '85',    unit: 'mL/min', range: '≥60',      flag: null },
        { name: 'Na',      value: '141',   unit: 'mmol/L', range: '136–145',  flag: null },
        { name: 'K',       value: '4.4',   unit: 'mmol/L', range: '3.5–5.0',  flag: null },
        { name: 'AST',     value: '28',    unit: 'U/L',    range: '10–40',    flag: null },
        { name: 'ALT',     value: '24',    unit: 'U/L',    range: '10–40',    flag: null },
        { name: 'Glucose', value: '108',   unit: 'mg/dL',  range: '70–110',   flag: null },
        { name: 'BNP',     value: '42',    unit: 'pg/mL',  range: '<100',     flag: null },
      ],
    },
    {
      collectedAt: '2026-03-12T07:55:08+09:00',
      resultedAt:  '2026-03-12T09:18:27+09:00',
      rows: [
        { name: 'BUN',     value: '13',    unit: 'mg/dL',  range: '8–20',     flag: null },
        { name: 'Cr',      value: '0.88',  unit: 'mg/dL',  range: '0.7–1.3',  flag: null },
        { name: 'eGFR',    value: '92',    unit: 'mL/min', range: '≥60',      flag: null },
        { name: 'Na',      value: '140',   unit: 'mmol/L', range: '136–145',  flag: null },
        { name: 'K',       value: '4.1',   unit: 'mmol/L', range: '3.5–5.0',  flag: null },
        { name: 'AST',     value: '22',    unit: 'U/L',    range: '10–40',    flag: null },
        { name: 'ALT',     value: '19',    unit: 'U/L',    range: '10–40',    flag: null },
        { name: 'Glucose', value: '98',    unit: 'mg/dL',  range: '70–110',   flag: null },
        { name: 'BNP',     value: '34',    unit: 'pg/mL',  range: '<100',     flag: null },
      ],
    },
  ],
  abg: [
    {
      collectedAt: '2026-04-23T07:48:32+09:00',
      resultedAt:  '2026-04-23T08:12:09+09:00',
      rows: [
        { name: 'pH',           value: '7.41', unit: '',       range: '7.35–7.45', flag: null },
        { name: 'PaO₂',         value: '78',   unit: 'mmHg',   range: '80–100',    flag: 'low' },
        { name: 'PaCO₂',        value: '38',   unit: 'mmHg',   range: '35–45',     flag: null },
        { name: 'HCO₃⁻',        value: '24',   unit: 'mmol/L', range: '22–26',     flag: null },
        { name: 'SaO₂',         value: '94',   unit: '%',      range: '95–100',    flag: 'low' },
        { name: 'A-a gradient', value: '22',   unit: 'mmHg',   range: '<15',       flag: 'high' },
        { name: 'Lactate',      value: '1.2',  unit: 'mmol/L', range: '<2.0',      flag: null },
      ],
    },
    {
      collectedAt: '2026-04-09T08:22:11+09:00',
      resultedAt:  '2026-04-09T08:46:54+09:00',
      rows: [
        { name: 'pH',           value: '7.39', unit: '',       range: '7.35–7.45', flag: null },
        { name: 'PaO₂',         value: '74',   unit: 'mmHg',   range: '80–100',    flag: 'low' },
        { name: 'PaCO₂',        value: '40',   unit: 'mmHg',   range: '35–45',     flag: null },
        { name: 'HCO₃⁻',        value: '23',   unit: 'mmol/L', range: '22–26',     flag: null },
        { name: 'SaO₂',         value: '92',   unit: '%',      range: '95–100',    flag: 'low' },
        { name: 'A-a gradient', value: '26',   unit: 'mmHg',   range: '<15',       flag: 'high' },
        { name: 'Lactate',      value: '1.4',  unit: 'mmol/L', range: '<2.0',      flag: null },
      ],
    },
  ],
  inflam: [
    {
      collectedAt: '2026-04-23T07:42:18+09:00',
      resultedAt:  '2026-04-23T09:14:36+09:00',
      rows: [
        { name: 'CRP',           value: '0.8',  unit: 'mg/dL', range: '<0.5',  flag: 'high' },
        { name: 'ESR',           value: '38',   unit: 'mm/hr', range: '<20',   flag: 'high' },
        { name: 'Procalcitonin', value: '0.05', unit: 'ng/mL', range: '<0.05', flag: null },
        { name: 'KL-6',          value: '1284', unit: 'U/mL',  range: '<500',  flag: 'critical' },
        { name: 'SP-D',          value: '178',  unit: 'ng/mL', range: '<110',  flag: 'high' },
        { name: 'ANA',           value: '1:80', unit: '',      range: '<1:80', flag: null },
        { name: 'RF',            value: '14',   unit: 'IU/mL', range: '<14',   flag: null },
        { name: 'Anti-CCP',      value: '6',    unit: 'U/mL',  range: '<7',    flag: null },
      ],
    },
    {
      collectedAt: '2026-04-09T08:14:33+09:00',
      resultedAt:  '2026-04-09T09:48:22+09:00',
      rows: [
        { name: 'CRP',           value: '0.6',  unit: 'mg/dL', range: '<0.5',  flag: 'high' },
        { name: 'ESR',           value: '32',   unit: 'mm/hr', range: '<20',   flag: 'high' },
        { name: 'Procalcitonin', value: '0.04', unit: 'ng/mL', range: '<0.05', flag: null },
        { name: 'KL-6',          value: '1158', unit: 'U/mL',  range: '<500',  flag: 'critical' },
        { name: 'SP-D',          value: '162',  unit: 'ng/mL', range: '<110',  flag: 'high' },
        { name: 'ANA',           value: '1:80', unit: '',      range: '<1:80', flag: null },
        { name: 'RF',            value: '12',   unit: 'IU/mL', range: '<14',   flag: null },
        { name: 'Anti-CCP',      value: '5',    unit: 'U/mL',  range: '<7',    flag: null },
      ],
    },
    {
      collectedAt: '2026-03-12T07:55:08+09:00',
      resultedAt:  '2026-03-12T09:32:14+09:00',
      rows: [
        { name: 'CRP',           value: '0.4',  unit: 'mg/dL', range: '<0.5',  flag: null },
        { name: 'ESR',           value: '24',   unit: 'mm/hr', range: '<20',   flag: 'high' },
        { name: 'Procalcitonin', value: '0.03', unit: 'ng/mL', range: '<0.05', flag: null },
        { name: 'KL-6',          value: '982',  unit: 'U/mL',  range: '<500',  flag: 'critical' },
        { name: 'SP-D',          value: '148',  unit: 'ng/mL', range: '<110',  flag: 'high' },
        { name: 'ANA',           value: '1:40', unit: '',      range: '<1:80', flag: null },
        { name: 'RF',            value: '11',   unit: 'IU/mL', range: '<14',   flag: null },
        { name: 'Anti-CCP',      value: '4',    unit: 'U/mL',  range: '<7',    flag: null },
      ],
    },
  ],
};

/* legacy 평면 배열도 받아 단일 패널로 wrap. 항상 최신(resultedAt desc) 정렬. */
function normalizeLabPanels(catData) {
  if (!catData) return [];
  if (Array.isArray(catData) && catData.length > 0 && Array.isArray(catData[0]?.rows)) {
    return [...catData].sort((a, b) => {
      const ka = a.resultedAt || a.collectedAt || '';
      const kb = b.resultedAt || b.collectedAt || '';
      return kb.localeCompare(ka);
    });
  }
  if (Array.isArray(catData)) {
    return [{ collectedAt: null, resultedAt: null, rows: catData }];
  }
  return [];
}

/* ----------- VITALS SECTION · 시점별 셀렉터 + 값 표시 -----------
 * controlled — 부모 (ChartOverview/PatientChart) 가 idx state 보유.
 * 부모 prop 없으면 자체 state 로 fallback (legacy 사용처 호환).
 * ----------------------------------------------------------------- */
function VitalsSection({ patient, idx: idxProp, onIdxChange }) {
  const history = normalizeVitalsHistory(patient);
  const [localIdx, setLocalIdx] = useState(0);
  useEffect(() => { setLocalIdx(0); }, [patient.mrn]);
  const isControlled = typeof idxProp === 'number';
  const idx = isControlled ? idxProp : localIdx;
  const setIdx = isControlled ? (i) => onIdxChange && onIdxChange(i) : setLocalIdx;
  const safeIdx = Math.min(idx, Math.max(0, history.length - 1));
  const sel = history[safeIdx] || { vitals: '—' };
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5" style={{ whiteSpace: 'nowrap', minWidth: 0 }}>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>
          바이탈 · Vitals
        </div>
      </div>
      <TimePointSelect
        items={history.map(h => ({ stamp: h.measuredAt }))}
        selectedIdx={safeIdx}
        onSelect={setIdx}
        label="측정 시각"
        icon={Activity}
      />
      <div style={{ width: '100%' }}>
        <AutoFitText
          max={13}
          min={9}
          className="font-mono leading-relaxed"
          style={{ color: 'var(--rl-ink)' }}
        >
          {sel.vitals}
        </AutoFitText>
      </div>
    </div>
  );
}

/* Lab status 결정 · 환자 status 기반 (override: patient.labStatus) */
function getLabStatus(patient) {
  if (patient.labStatus) return patient.labStatus;
  if (patient.status === 'ready')     return 'ready';
  if (patient.status === 'analyzing') return 'pending';
  return 'none';
}

function LabSection({ patient, labIdx, onLabIdxChange }) {
  const labStatus = getLabStatus(patient);

  // 공통 헤더
  const Header = ({ trailing }) => (
    <div className="flex items-baseline gap-2 mb-2" style={{ whiteSpace: 'nowrap', minWidth: 0 }}>
      <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>
        검사 결과 · Labs
      </div>
      <span className="ml-auto font-mono text-[10px] truncate" style={{ color: 'var(--rl-ink-4)', minWidth: 0 }}>
        {trailing}
      </span>
    </div>
  );

  if (labStatus === 'none') {
    return (
      <div>
        <Header trailing="미오더" />
        <LabNoneState />
      </div>
    );
  }

  if (labStatus === 'pending') {
    return (
      <div>
        <Header trailing="검체 채취 · 결과 대기" />
        <LabPendingState />
      </div>
    );
  }

  // ready
  return <LabReadyState patient={patient} labIdx={labIdx} onLabIdxChange={onLabIdxChange} />;
}

function LabNoneState() {
  return (
    <div
      className="rounded p-3 text-center text-xs flex flex-col items-center gap-1.5"
      style={{ background: 'var(--rl-bg-2)', border: '1px dashed var(--rl-border)' }}
    >
      <Microscope size={18} style={{ color: 'var(--rl-ink-4)' }} />
      <div style={{ color: 'var(--rl-ink-3)' }}>처방된 검사가 없습니다</div>
      <button
        className="font-mono text-[10px] uppercase tracking-widest hover:underline mt-0.5"
        style={{ color: 'var(--rl-primary)' }}
      >
        + 검사 처방
      </button>
    </div>
  );
}

function LabPendingState() {
  // mock: 채혈은 약 90 분 전, 예상 결과는 약 30 분 후
  const collected = '2026-04-23T07:42:18+09:00';
  const expected  = '2026-04-23T09:15:00+09:00';
  return (
    <div
      className="rounded p-3 text-xs flex flex-col items-center gap-1.5"
      style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)' }}
    >
      <Loader2 size={18} className="spin" style={{ color: 'var(--rl-amber)' }} />
      <div className="font-medium text-center" style={{ color: 'var(--rl-amber)' }}>
        검체 채취 완료 · 결과 분석 중
      </div>
      <div style={{ width: '100%' }}>
        <AutoFitText
          max={10}
          min={7.5}
          className="font-mono"
          style={{ color: 'var(--rl-ink-3)', textAlign: 'center' }}
        >
          채혈 {fmtDateTime(collected)} KST · 예상 결과 {fmtDateTime(expected)}
        </AutoFitText>
      </div>
      <div className="grid grid-cols-2 gap-1 w-full mt-1">
        {['CBC', 'Chem', 'ABG', 'Markers'].map(k => (
          <div
            key={k}
            className="flex items-center gap-1.5 px-2 py-1 rounded"
            style={{ background: 'rgba(255,255,255,0.6)' }}
          >
            <Loader2 size={9} className="spin" style={{ color: 'var(--rl-amber)' }} />
            <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-2)' }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LabReadyState({ patient, labIdx: labIdxProp, onLabIdxChange }) {
  const [tab, setTab] = useState('cbc');
  // controlled — 부모가 카테고리별 panel idx 보유. 없으면 자체 state.
  const [localLabIdx, setLocalLabIdx] = useState({ cbc: 0, chem: 0, abg: 0, inflam: 0 });
  const isControlled = !!labIdxProp;
  const labIdx = isControlled ? labIdxProp : localLabIdx;
  const setPanelIdxFor = (cat, i) => {
    if (isControlled) onLabIdxChange && onLabIdxChange(cat, i);
    else setLocalLabIdx((prev) => ({ ...prev, [cat]: i }));
  };
  const labs = patient.labs || DEFAULT_LAB_PANELS;
  const tabs = [
    { k: 'cbc',    label: 'CBC' },
    { k: 'chem',   label: 'Chem' },
    { k: 'abg',    label: 'ABG' },
    { k: 'inflam', label: 'Markers' },
  ];

  const panels = normalizeLabPanels(labs[tab]);
  const currentIdx = labIdx[tab] || 0;
  const setPanelIdx = (i) => setPanelIdxFor(tab, i);

  // 환자 바뀌면 자체 state 라면 리셋 (controlled 면 부모가 처리)
  useEffect(() => { if (!isControlled) setLocalLabIdx({ cbc: 0, chem: 0, abg: 0, inflam: 0 }); }, [patient.mrn]);

  const safeIdx = Math.min(currentIdx, Math.max(0, panels.length - 1));
  const currentPanel = panels[safeIdx] || { rows: [] };
  const rows = currentPanel.rows || [];

  // 카테고리별 최신 패널 기준으로 abnormal 카운트
  const totalAbnormal = ['cbc','chem','abg','inflam'].reduce((s, k) => {
    const ps = normalizeLabPanels(labs[k]);
    const r = ps[0]?.rows || [];
    return s + r.filter(x => x.flag).length;
  }, 0);

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2" style={{ whiteSpace: 'nowrap', minWidth: 0 }}>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>
          검사 결과 · Labs
        </div>
        {totalAbnormal > 0 && (
          <span className="font-mono text-[10px]" style={{ color: 'var(--rl-amber)', flexShrink: 0 }}>
            · {totalAbnormal}건 이상치
          </span>
        )}
      </div>

      {/* Lab category tabs */}
      <div className="flex items-center gap-1 mb-2" style={{ whiteSpace: 'nowrap' }}>
        {tabs.map(t => {
          const active = tab === t.k;
          const ps = normalizeLabPanels(labs[t.k]);
          const ab = (ps[0]?.rows || []).filter(r => r.flag).length;
          return (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className="px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider rounded transition flex items-center gap-1"
              style={{
                background: active ? 'var(--rl-primary)' : 'var(--rl-bg-3)',
                color: active ? 'white' : 'var(--rl-ink-2)',
              }}
            >
              {t.label}
              {ab > 0 && (
                <span
                  className="font-mono text-[9px] px-1 rounded"
                  style={{
                    background: active ? 'rgba(255,255,255,0.22)' : 'var(--rl-amber-soft)',
                    color: active ? 'white' : 'var(--rl-amber)',
                  }}
                >
                  {ab}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 결과 일시 선택 · 한 줄 드롭다운 (디폴트: 최신) */}
      <TimePointSelect
        items={panels.map(p => ({
          stamp: p.resultedAt || p.collectedAt,
          sub: p.collectedAt && p.resultedAt
            ? `채혈 ${fmtDateTime(p.collectedAt)}`
            : null,
        }))}
        selectedIdx={safeIdx}
        onSelect={setPanelIdx}
        label="결과 일시"
      />

      {/* Lab table · header + rows · 4-column 고정 grid */}
      <div className="grid items-baseline font-mono text-[9px] uppercase tracking-widest pb-1" style={{
        gridTemplateColumns: LAB_GRID,
        columnGap: 6,
        color: 'var(--rl-ink-4)',
        borderBottom: '1px solid var(--rl-border-soft)',
      }}>
        <div>검사</div>
        <div style={{ textAlign: 'right' }}>값</div>
        <div>단위</div>
        <div style={{ textAlign: 'right' }}>정상범위</div>
      </div>
      <div>
        {rows.map((r, i) => <LabRow key={i} {...r} isLast={i === rows.length - 1} />)}
      </div>
    </div>
  );
}

/* ----------- TIMEPOINT SELECT · 한 줄 + 펼침 드롭다운 ------------
 * 검사·바이탈·이미지 등 시점별 데이터 공통 셀렉터.
 * - 닫힘: 1줄 (LATEST/T-N 배지 + 일시 + 화살표)
 * - 클릭: 아래로 리스트 펼침 → 클릭 시 선택 + 닫힘 + outside 클릭/ESC 도 닫힘
 * - 디폴트는 항상 items[0] (최신)
 * - items: [{ stamp: ISOString, sub?: string }, ...]   (최신순으로 정렬되어 들어옴)
 * --------------------------------------------------------------- */
function TimePointSelect({
  items,
  selectedIdx,
  onSelect,
  label = '결과 일시',
  icon: Icon = Clock,
  noMargin = false,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!items || items.length === 0) return null;
  const safeIdx = Math.min(Math.max(selectedIdx, 0), items.length - 1);
  const sel = items[safeIdx];

  const Pill = ({ idx, active = false }) => {
    const isLatest = idx === 0;
    return (
      <span
        className="font-mono text-[8px] uppercase tracking-widest px-1 rounded"
        style={{
          background: isLatest ? 'var(--rl-teal-soft, #E6F5F2)' : 'var(--rl-bg-3)',
          color: isLatest ? 'var(--rl-teal, #0E8574)' : 'var(--rl-ink-3)',
          flexShrink: 0,
          fontWeight: active ? 600 : 500,
        }}
      >
        {isLatest ? 'LATEST' : `T-${idx}`}
      </span>
    );
  };

  return (
    <div ref={ref} className={noMargin ? '' : 'mb-2'} style={{ position: 'relative' }}>
      {/* 닫힘: 1줄 (라벨/뱃지/일시/카운터/▼ 모두 한 줄, 폭 모자라면 일시 자동 축소) */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 rounded transition"
        style={{
          background: 'white',
          border: '1px solid var(--rl-border-soft)',
          padding: '3px 8px',
          minWidth: 0,
          cursor: 'pointer',
          textAlign: 'left',
          whiteSpace: 'nowrap',
        }}
        title={sel.sub ? `${fmtDateTime(sel.stamp)} · ${sel.sub}` : fmtDateTime(sel.stamp)}
      >
        <Icon size={10} style={{ color: 'var(--rl-ink-4)', flexShrink: 0 }} />
        <span
          className="font-mono text-[9px] uppercase tracking-widest"
          style={{ color: 'var(--rl-ink-4)', flexShrink: 0 }}
        >
          {label}
        </span>
        <Pill idx={safeIdx} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <AutoFitText
            max={10.5}
            min={7.5}
            className="font-mono"
            style={{ color: 'var(--rl-ink)', fontWeight: 600, letterSpacing: '0.01em' }}
          >
            {fmtDateTime(sel.stamp)}
          </AutoFitText>
        </div>
        <span
          className="font-mono text-[9px]"
          style={{ color: 'var(--rl-ink-4)', flexShrink: 0 }}
        >
          {safeIdx + 1}/{items.length}
        </span>
        <ChevronDown
          size={11}
          style={{
            color: 'var(--rl-ink-3)',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 120ms',
          }}
        />
      </button>

      {/* 펼침: 항목당 1줄 (뱃지 + 일시) */}
      {open && (
        <div
          role="listbox"
          className="rounded"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: 'white',
            border: '1px solid var(--rl-border)',
            zIndex: 50,
            maxHeight: 240,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(10,22,40,0.12)',
          }}
        >
          {items.map((it, i) => {
            const active = i === safeIdx;
            return (
              <button
                key={i}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onSelect(i); setOpen(false); }}
                title={it.sub ? `${fmtDateTime(it.stamp)} · ${it.sub}` : fmtDateTime(it.stamp)}
                className="w-full text-left flex items-center gap-1.5 transition"
                style={{
                  padding: '4px 8px',
                  background: active ? 'var(--rl-primary-soft, #E5EEF7)' : 'white',
                  borderBottom: i === items.length - 1 ? 'none' : '1px solid var(--rl-border-soft)',
                  cursor: 'pointer',
                  minWidth: 0,
                }}
              >
                <Pill idx={i} active={active} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <AutoFitText
                    max={9.5}
                    min={7.5}
                    className="font-mono"
                    style={{
                      color: active ? 'var(--rl-primary)' : 'var(--rl-ink)',
                      fontWeight: active ? 600 : 500,
                    }}
                  >
                    {fmtDateTime(it.stamp)}
                  </AutoFitText>
                </div>
                {active && <CheckCircle2 size={10} style={{ color: 'var(--rl-primary)', flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- VITALS · 시점별 history ----------
 * EMR Observation 상응. measuredAt 메타데이터 + vitals 문자열 페어.
 * ----------------------------------------------- */
const DEFAULT_VITALS_HISTORY = [
  { measuredAt: '2026-04-23T08:32:14+09:00', vitals: 'BP 130/80 · HR 84 · RR 18 · SpO₂ 96% (RA) · T 36.7°C' },
  { measuredAt: '2026-04-23T07:42:18+09:00', vitals: 'BP 134/82 · HR 88 · RR 18 · SpO₂ 95% (RA) · T 36.8°C' },
  { measuredAt: '2026-04-09T08:32:42+09:00', vitals: 'BP 128/78 · HR 82 · RR 18 · SpO₂ 95% (RA) · T 36.6°C' },
  { measuredAt: '2026-03-12T08:30:11+09:00', vitals: 'BP 126/76 · HR 80 · RR 16 · SpO₂ 96% (RA) · T 36.5°C' },
];

function normalizeVitalsHistory(patient) {
  if (Array.isArray(patient.vitalsHistory) && patient.vitalsHistory.length > 0) {
    return [...patient.vitalsHistory].sort((a, b) =>
      String(b.measuredAt || '').localeCompare(String(a.measuredAt || ''))
    );
  }
  // patient.vitals(문자열) 만 있는 경우: 기본 history 의 timestamp 를 차용,
  // 최신 항목만 patient.vitals 로 교체해서 dropdown 에 실제 시각이 보이게 한다.
  if (patient.vitals) {
    const [latest, ...rest] = DEFAULT_VITALS_HISTORY;
    return [{ measuredAt: latest.measuredAt, vitals: patient.vitals }, ...rest];
  }
  return DEFAULT_VITALS_HISTORY;
}

/* ---------- CXR · 시점별 study ----------
 * FHIR ImagingStudy 상응. 스터디ID + 촬영시각 메타데이터.
 * ----------------------------------------- */
const DEFAULT_CXR_STUDIES = [
  { studyId: 'STU-2026-0423-0021', capturedAt: '2026-04-23T07:54:12+09:00', view: 'PA · Frontal',  modality: 'CR' },
  { studyId: 'STU-2026-0409-0118', capturedAt: '2026-04-09T08:48:33+09:00', view: 'PA · Frontal',  modality: 'CR' },
  { studyId: 'STU-2026-0312-0084', capturedAt: '2026-03-12T08:42:55+09:00', view: 'PA + Lateral',  modality: 'CR' },
];

function normalizeCxrStudies(patient) {
  if (Array.isArray(patient.cxrStudies) && patient.cxrStudies.length > 0) {
    return [...patient.cxrStudies].sort((a, b) =>
      String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
    );
  }
  return DEFAULT_CXR_STUDIES;
}

const LAB_GRID = 'minmax(0, 1fr) 56px 60px 72px';

function LabRow({ name, value, unit, range, flag, isLast }) {
  const flagColor =
    flag === 'critical' ? 'var(--rl-critical)' :
    flag === 'high'     ? 'var(--rl-critical)' :
    flag === 'low'      ? 'var(--rl-amber)' :
    'var(--rl-ink)';
  const flagSymbol =
    flag === 'critical' ? '↑↑' :
    flag === 'high'     ? '↑' :
    flag === 'low'      ? '↓' :
    '';
  return (
    <div
      className="grid items-baseline py-1"
      style={{
        gridTemplateColumns: LAB_GRID,
        columnGap: 6,
        borderBottom: isLast ? 'none' : '1px solid var(--rl-border-soft)',
      }}
    >
      <div className="text-[11px] truncate" style={{ color: 'var(--rl-ink-2)' }}>{name}</div>
      <div
        className="font-mono text-[11px] flex items-baseline gap-0.5 justify-end"
        style={{ color: flagColor, fontWeight: flag ? 600 : 400 }}
      >
        <span>{value}</span>
        {flagSymbol && <span className="text-[10px]">{flagSymbol}</span>}
      </div>
      <div className="font-mono text-[10px] truncate" style={{ color: 'var(--rl-ink-3)' }}>{unit}</div>
      <div className="font-mono text-[10px] text-right" style={{ color: 'var(--rl-ink-4)' }}>{range}</div>
    </div>
  );
}

function Panel({ title, mono, right, children, fill }) {
  return (
    <div
      className="hairline rounded bg-white"
      style={fill ? { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', minWidth: 0 } : { minWidth: 0 }}
    >
      <div
        className="px-3 py-2 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--rl-border-soft)', flexShrink: 0, whiteSpace: 'nowrap', minWidth: 0 }}
      >
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>
          {mono}
        </div>
        <div className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)', minWidth: 0 }}>{title}</div>
        {right && <div className="ml-auto" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{right}</div>}
      </div>
      <div
        className="p-3"
        style={fill ? { flex: 1, minHeight: 0, overflow: 'auto' } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/* ----------- TAB · CXR (좌 원본 / 우 AI Heatmap 비교) ----------- */
function ChartCXR({ patient, snap, onReanalyze }) {
  const isAnalyzing = patient.cxrAnalyzing === true;
  const isAnalyzed = patient.status === 'ready';   // CXR AI 분석 완료 여부
  const labels = deriveChexpertLabels(patient);
  const positiveLabels = labels.filter(l => l.score >= 0.5);  // score desc 정렬됨
  const topPositive = positiveLabels[0]?.name || null;        // 최고 % label
  const [selectedLabel, setSelectedLabel] = useState(null);
  const focalRegions = selectedLabel ? LABEL_FOCAL_REGIONS[selectedLabel] : null;
  // Overview 에서 선택된 시점 (snap.cxrIdx) 의 study — 같은 시점이 CXR 탭에도 반영
  const cxrStudies = normalizeCxrStudies(patient);
  const selectedCxrIdx = Math.min(snap?.cxrIdx ?? 0, Math.max(0, cxrStudies.length - 1));
  const selectedStudy = cxrStudies[selectedCxrIdx] || null;

  // 환자 바뀌거나 재분석 끝나면 max-positive 자동 선택 (없으면 null → "이상 없음").
  useEffect(() => {
    if (!isAnalyzing) {
      const positives = (labels || [])
        .filter(l => l.score >= 0.5)
        .sort((a, b) => b.score - a.score);
      setSelectedLabel(positives.length ? positives[0].name : null);
    } else {
      setSelectedLabel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient.mrn, isAnalyzing]);

  return (
    <div className="h-full fade-in">
      <Panel
        title="CXR · 비교 뷰어"
        mono="Original ↔ Heatmap"
        fill
        right={
          <div className="flex items-center gap-2">
            <ReanalyzeButton onClick={onReanalyze} disabled={isAnalyzing} />
            <button
              onClick={() => openCxrPopup(patient, selectedStudy)}
              className="text-[11px] font-medium flex items-center gap-1 hover:underline"
              style={{ color: 'var(--rl-primary)' }}
            >
              새 창에서 보기 <ArrowUpRight size={11} />
            </button>
          </div>
        }
      >
        <div className="h-full flex flex-col gap-2" style={{ minHeight: 0 }}>
          <div
            className="grid gap-3 flex-1"
            style={{ gridTemplateColumns: '180px minmax(0, 1fr) minmax(0, 1fr)', minHeight: 0 }}
          >
            {/* Left · positive label list */}
            <div className="flex flex-col gap-1.5 overflow-auto" style={{ minHeight: 0 }}>
              <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>
                {isAnalyzed ? `양성 label · ${positiveLabels.length}건` : '양성 label'}
              </div>
              {!isAnalyzed ? (
                <div className="text-[11px] py-2" style={{ color: 'var(--rl-ink-3)' }}>
                  분석 정보 없음 · AI 분석 미완료
                </div>
              ) : positiveLabels.length === 0 ? (
                <div className="text-[11px] py-2 flex items-center gap-1.5" style={{ color: 'var(--rl-teal)' }}>
                  <CheckCircle2 size={12} /> 이상 없음 (모두 &lt; 0.50)
                </div>
              ) : (
                positiveLabels.map(l => (
                  <CxrLabelItem
                    key={l.name}
                    name={l.name}
                    score={l.score}
                    active={selectedLabel === l.name}
                    onClick={() => setSelectedLabel(prev => (prev === l.name ? topPositive : l.name))}
                  />
                ))
              )}
              {isAnalyzed && topPositive && selectedLabel && selectedLabel !== topPositive && (
                <button
                  onClick={() => setSelectedLabel(topPositive)}
                  className="text-[10px] font-mono mt-1 hover:underline flex items-center gap-1"
                  style={{ color: 'var(--rl-amber)' }}
                  title={`최고 % label (${topPositive}) heatmap 으로 복귀`}
                >
                  <X size={10} /> 최고 label 복귀
                </button>
              )}
              {isAnalyzed && positiveLabels.length > 0 && (
                <div className="text-[10px] mt-auto pt-2" style={{ color: 'var(--rl-ink-3)' }}>
                  클릭 시 우측 heatmap 초점이 해당 label로 전환됩니다.
                </div>
              )}
            </div>

            {/* Original CXR — Overview 에서 선택된 시점 그대로 */}
            <CxrFrame patient={patient} study={selectedStudy} heatmap={false} caption="원본 · Original" />

            {/* Heatmap CXR — focal region 라벨에 따라 변경 */}
            <CxrFrame
              patient={patient}
              study={selectedStudy}
              heatmap={true}
              caption="Heatmap"
              focalRegions={focalRegions}
              labelName={selectedLabel}
            />
          </div>
          <div className="text-[11px] text-center flex-shrink-0" style={{ color: 'var(--rl-ink-3)' }}>
            PACS 통합 + Window/Level + 측정 도구는 <span className="font-mono">W3 · 5/4~5/10</span> 구현 예정
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ----- 양성 label 카드 (좌측 사이드바용) ----- */
function CxrLabelItem({ name, score, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-left px-2 py-1.5 rounded transition hover:opacity-95"
      style={{
        background: active ? 'var(--rl-amber-soft)' : 'var(--rl-bg-2)',
        border: '1px solid ' + (active ? 'var(--rl-amber)' : 'var(--rl-border-soft)'),
        cursor: 'pointer',
        flexShrink: 0,
      }}
      title={`${name} → heatmap 전환`}
    >
      <div className="flex items-baseline justify-between mb-1" style={{ minWidth: 0 }}>
        <span
          className="text-[11px] font-medium"
          style={{
            color: active ? 'var(--rl-amber)' : 'var(--rl-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
          }}
        >
          {name}
        </span>
        <span
          className="font-mono text-[10px] ml-2 flex-shrink-0"
          style={{ color: active ? 'var(--rl-amber)' : 'var(--rl-critical)' }}
        >
          {(score * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-1 rounded" style={{ background: 'var(--rl-bg-3)', overflow: 'hidden' }}>
        <div
          className="h-full rounded"
          style={{
            width: `${Math.round(score * 100)}%`,
            background: active ? 'var(--rl-amber)' : 'var(--rl-critical)',
          }}
        />
      </div>
    </button>
  );
}

function CxrFrame({ patient, study: studyProp, heatmap, caption, focalRegions = null, labelName = null }) {
  // study prop 있으면 그대로, 없으면 환자의 최신 CXR study
  const studies = normalizeCxrStudies(patient);
  const latest = studyProp || studies[0] || null;
  const captionColor = heatmap ? 'var(--rl-amber)' : 'var(--rl-ink-2)';
  return (
    <div className="flex flex-col items-center" style={{ minHeight: 0, minWidth: 0, flex: '1 1 0' }}>
      {/* Caption row — 높이 고정 · 한 줄 · 넘치면 ellipsis. 라벨명 길어도 이미지 영역 침범 X */}
      <div
        className="font-mono text-[10px] uppercase tracking-widest mb-1.5 flex items-center gap-1.5"
        style={{
          color: captionColor,
          height: 14,
          lineHeight: '14px',
          width: '100%',
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <span className="rounded-full" style={{ background: captionColor, width: 6, height: 6, flexShrink: 0 }} />
        <span style={{ flexShrink: 0 }}>{caption}</span>
        {heatmap && labelName && (
          <span
            className="font-mono normal-case tracking-normal"
            style={{
              color: 'var(--rl-amber)',
              fontSize: 9,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={labelName}
          >
            · {labelName}
          </span>
        )}
      </div>
      {/* Square frame · height 기준 1:1, 양 옆 흰 여백은 부모(Panel) 흰 배경 */}
      <div
        className="hairline-strong rounded"
        style={{
          background: '#0A1628',
          position: 'relative',
          overflow: 'hidden',
          borderColor: heatmap ? 'rgba(180,83,9,0.4)' : undefined,
          flex: '1 1 0',
          minHeight: 0,
          aspectRatio: '1 / 1',
          maxWidth: '100%',
        }}
      >
        {patient.cxrAnalyzing && <CxrAnalyzingOverlay />}
        {patient.cxr !== 'arrived' ? (
          <div className="absolute inset-0 flex items-center justify-center text-white opacity-50 font-mono text-xs">촬영 대기 중</div>
        ) : heatmap ? (
          // Heatmap 3-state:
          //   분석 미완료(status≠ready)        → "분석 정보 없음"
          //   분석 완료 + 양성 label 없음(정상) → "이상 없음"
          //   분석 완료 + 양성 label 있음       → heatmap (최고 % label 초점)
          (() => {
            const analyzed = patient.status === 'ready';
            if (!analyzed) return <CxrHeatmapState kind="none" />;
            const positives = deriveChexpertLabels(patient).filter(l => l.score >= 0.5);
            if (!positives.length) return <CxrHeatmapState kind="normal" />;
            // labelName 미지정 시 최고 % label 을 디폴트 초점으로 — 모든 탭 일관성
            const effLabel = labelName || positives[0].name;
            const effFocal = focalRegions || LABEL_FOCAL_REGIONS[effLabel] || null;
            return <CxrViewer study={latest} heatmap={true} focalRegions={effFocal} labelName={effLabel} />;
          })()
        ) : (
          <CxrViewer study={latest} heatmap={false} />
        )}
      </div>
    </div>
  );
}

/* ----- Heatmap 상태 메시지 (분석 미완료 / 정상) — CXR 검은 프레임 위 ----- */
function CxrHeatmapState({ kind }) {
  // kind: 'none' = 분석 미완료 / 'normal' = 이상 없음
  const cfg = kind === 'normal'
    ? { icon: <CheckCircle2 size={30} />, color: '#34D399', title: '이상 없음',
        sub: 'AI 분석 결과 양성 소견 없음 · 모든 label < 50%' }
    : { icon: <Microscope size={30} />, color: 'rgba(255,255,255,0.42)', title: '분석 미완료',
        sub: 'CXR AI 분석이 완료되지 않았습니다' };
  return (
    <div className="absolute inset-0 flex items-center justify-center fade-in">
      <div className="text-center" style={{ padding: 16 }}>
        <div style={{ color: cfg.color, marginBottom: 10 }}>{cfg.icon}</div>
        <div style={{ color: 'rgba(255,255,255,0.95)', fontSize: 14, marginBottom: 4 }}>{cfg.title}</div>
        <div className="font-mono text-[10px]" style={{ color: 'rgba(255,255,255,0.5)' }}>{cfg.sub}</div>
      </div>
    </div>
  );
}

/* ----------- CXR analyzing badge · 재분석 중 시각 (CXR 가리지 않는 코너 배지)
    의도: 재분석 시 CXR 전체를 덮어 화면 전체가 멈춘 느낌을 주지 않음.
    무거운 로딩 표현은 우측 AI 분석 패널의 spinner 가 담당.                       */
function CxrAnalyzingOverlay() {
  return (
    <div
      className="absolute fade-in flex items-center gap-1.5"
      style={{
        top: 8, right: 8, zIndex: 10,
        background: 'rgba(10,22,40,0.92)', color: 'white',
        padding: '5px 10px', borderRadius: 4,
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        border: '1px solid rgba(77,212,245,0.45)',
      }}
    >
      <Loader2 size={11} className="spin" style={{ color: '#4DD4F5' }} />
      <span className="font-mono text-[10px] uppercase tracking-wider">AI 재분석</span>
    </div>
  );
}

/* ----------- 공용 재분석 버튼 (amber) ----------- */
function ReanalyzeButton({ onClick, disabled, label = '재분석' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] font-medium flex items-center gap-1 px-2 py-0.5 rounded transition hover:opacity-90"
      style={{
        background: disabled ? 'var(--rl-bg-3)' : 'var(--rl-amber-soft)',
        color: disabled ? 'var(--rl-ink-3)' : 'var(--rl-amber)',
        cursor: disabled ? 'wait' : 'pointer',
        border: '1px solid ' + (disabled ? 'var(--rl-border)' : 'var(--rl-amber)'),
      }}
      title={disabled ? '재분석 진행 중…' : 'AI 모델 재분석 요청'}
    >
      <RefreshCw size={10} className={disabled ? 'spin' : undefined} /> {label}
    </button>
  );
}

/* ----------- Patient banner 상의 큰 「전체 재분석」 ----------- */
function ReanalyzeAllButton({ onClick, analyzing }) {
  return (
    <button
      onClick={onClick}
      disabled={analyzing}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition hover:opacity-90"
      style={{
        background: analyzing ? 'var(--rl-bg-3)' : 'var(--rl-primary)',
        color:      analyzing ? 'var(--rl-ink-3)' : 'white',
        border: '1px solid ' + (analyzing ? 'var(--rl-border)' : 'var(--rl-primary)'),
        cursor: analyzing ? 'wait' : 'pointer',
        whiteSpace: 'nowrap',
      }}
      title={analyzing ? '전체 재분석 진행 중…' : 'CXR + 감별진단 모두 재분석'}
    >
      <RefreshCw size={13} className={analyzing ? 'spin' : undefined} />
      {analyzing ? '분석 중…' : '전체 재분석'}
    </button>
  );
}

/* ----------- Patient banner 상의 「정보 업데이트」 -----------
 * EMR 에서 끌어오지 못한 미수신 정보를 재요청.
 * - idle: 'EMR 정보 업데이트' (pending > 0 이면 우상단 빨간 배지)
 * - fetching: spinner + '업데이트 중…'
 * - success: ✓ + 'N건 갱신' (2초 후 idle 복귀)
 * --------------------------------------------------------- */
function EmrUpdateButton({ onClick, state = 'idle', pendingCount = 0, feedback }) {
  const fetching = state === 'fetching';
  const success  = state === 'success';

  const label = fetching ? '업데이트 중…'
    : success            ? `갱신 완료 · ${feedback?.count ?? 0}건`
    :                      'EMR 정보 업데이트';

  const palette = fetching ? { bg: 'var(--rl-bg-3)',                  fg: 'var(--rl-ink-3)', bd: 'var(--rl-border)' }
    : success              ? { bg: 'var(--rl-teal-soft, #E6F5F2)',    fg: 'var(--rl-teal)',  bd: 'var(--rl-teal)'  }
    :                        { bg: 'white',                           fg: 'var(--rl-teal)',  bd: 'var(--rl-teal)'  };

  return (
    <button
      onClick={onClick}
      disabled={fetching || success}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition hover:opacity-90"
      style={{
        background: palette.bg,
        color:      palette.fg,
        border:     `1px solid ${palette.bd}`,
        cursor:     fetching ? 'wait' : (success ? 'default' : 'pointer'),
        whiteSpace: 'nowrap',
        position:   'relative',
      }}
      title={
        fetching ? 'EMR 에서 환자 정보 재요청 중…'
        : success ? `${feedback?.count ?? 0}건 갱신 완료`
        : pendingCount > 0
          ? `미수신 ${pendingCount}건 · 클릭하여 EMR 재요청`
          : 'EMR 에서 환자 정보 재동기화'
      }
    >
      {fetching
        ? <Loader2 size={13} className="spin" />
        : success
          ? <CheckCircle2 size={13} />
          : <Database size={13} />
      }
      {label}
      {!fetching && !success && pendingCount > 0 && (
        <span
          aria-label={`미수신 ${pendingCount}건`}
          title={`미수신 ${pendingCount}건`}
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--rl-critical)',
            border: '1.5px solid white',
            boxShadow: '0 0 0 1px rgba(163,45,45,0.25)',
          }}
        />
      )}
    </button>
  );
}

/* ----------- CXR view toggle (원본 ↔ AI Heatmap) ----------- */
function CxrViewToggle({ view, onChange }) {
  const tabs = [
    { k: 'original', label: '원본' },
    { k: 'heatmap',  label: 'Heatmap' },
  ];
  return (
    <div className="flex items-center" style={{ background: 'var(--rl-bg-3)', padding: 2, borderRadius: 4 }}>
      {tabs.map(t => {
        const active = view === t.k;
        return (
          <button
            key={t.k}
            onClick={() => onChange(t.k)}
            className="px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider rounded transition"
            style={{
              background: active ? 'var(--rl-primary)' : 'transparent',
              color: active ? 'white' : 'var(--rl-ink-2)',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   TAB · WORKSPACE — 3-Panel 진단 워크스페이스 (#03)
   좌(입력 요약) · 중(CXR + AI + 14 label) · 우(감별진단 + 희귀 + 최종)
   Progressive phase rendering · 6 phase × {pending|running|succeeded|failed}
   3 retry buttons: 전체 재분석 · 이미지 재분석 · 희귀 재시도
   Mock 모드 — 실 Lambda 결선은 W4 (LAMBDA_INVENTORY_KO.md v3 참고)
   ============================================================ */
const PHASE_DEFS = [
  { key: 'phase1', label: 'HPO 추출',     short: 'P1' },
  { key: 'phase2', label: 'CXR DenseNet', short: 'P2' },
  { key: 'phase3', label: '105 스코어링', short: 'P3' },
  { key: 'phase4', label: 'LLM 검증',     short: 'P4' },
  { key: 'phase5', label: '희귀 listing', short: 'P5' },
  { key: 'final',  label: 'RAG 리포트',   short: 'F'  },
];

/* Pure presentational — state는 PatientChart가 보유. 탭 전환에 살아남음. */
function ChartWorkspace({ patient, snap, phases, attempt, onRerunAll, onRerunImage, onRerunRare, phase5Result = null, finalReport = null, reportState = 'idle' }) {
  // Overview 에서 선택된 시점 — Workspace 의 Phase 들이 같은 시점 데이터로 분석
  const wsCxr = normalizeCxrStudies(patient)[snap?.cxrIdx ?? 0];
  const wsVit = normalizeVitalsHistory(patient)[snap?.vitalsIdx ?? 0];
  const wsLab = (() => {
    const labs = patient.labs || DEFAULT_LAB_PANELS;
    const cats = ['cbc', 'chem', 'abg', 'inflam'];
    const out = {};
    for (const c of cats) {
      const ps = normalizeLabPanels(labs[c]);
      const i = (snap?.labIdx || {})[c] ?? 0;
      const p = ps[Math.min(i, Math.max(0, ps.length - 1))];
      if (p) out[c] = p.resultedAt || p.collectedAt;
    }
    return out;
  })();
  const fmt = (s) => s ? String(s).replace('T', ' ').slice(0, 19) : '—';
  return (
    <div className="h-full fade-in flex flex-col gap-2" style={{ minHeight: 0 }}>
      {/* 상단 strip · Phase 진행도 + 전체 재분석 */}
      <div className="flex items-center gap-3 px-1 flex-shrink-0">
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          Workspace · 3-Panel · Attempt #{attempt}
        </div>
        <PhaseStrip phases={phases} />
        <button
          onClick={onRerunAll}
          className="ml-auto text-[11px] font-medium flex items-center gap-1.5 px-2.5 py-1.5 rounded transition hover:opacity-90"
          style={{ background: 'var(--rl-primary)', color: 'white' }}
          title="모든 phase를 처음부터 다시 실행 (P1·P2·P3·P4·P5·Final)"
        >
          <RefreshCw size={11} /> 전체 재분석
        </button>
      </div>

      {/* 분석 시점 banner — Overview 시점 셀렉터 선택값 그대로 */}
      <div
        className="flex items-center gap-3 px-3 py-1.5 rounded font-mono text-[10px] flex-shrink-0"
        style={{ background: 'var(--rl-primary-soft)', border: '1px solid var(--rl-border-soft)', color: 'var(--rl-ink-3)' }}
        title="Overview 탭의 시점 셀렉터에서 선택된 데이터로 Phase 1~5 가 실행됩니다"
      >
        <span className="uppercase tracking-widest" style={{ color: 'var(--rl-primary)' }}>분석 시점</span>
        <span>CXR <b style={{ color: 'var(--rl-ink-2)' }}>{fmt(wsCxr?.capturedAt)}</b></span>
        <span>· Vitals <b style={{ color: 'var(--rl-ink-2)' }}>{fmt(wsVit?.measuredAt)}</b></span>
        <span>· Lab CBC <b style={{ color: 'var(--rl-ink-2)' }}>{fmt(wsLab.cbc)}</b></span>
        <span>· Lab Markers <b style={{ color: 'var(--rl-ink-2)' }}>{fmt(wsLab.inflam)}</b></span>
      </div>

      {/* 3-panel grid */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: '320px minmax(0, 1fr) 380px', flex: 1, minHeight: 0 }}
      >
        <WorkspaceLeftPanel patient={patient} phases={phases} />
        <WorkspaceCenterPanel patient={patient} phases={phases} onRerunImage={onRerunImage} />
        <WorkspaceRightPanel patient={patient} phases={phases} onRerunRare={onRerunRare} phase5Result={phase5Result} finalReport={finalReport} reportState={reportState} />
      </div>
    </div>
  );
}

/* ----- Phase 진행 strip (6개 미니 배지) ----- */
function PhaseStrip({ phases }) {
  return (
    <div className="flex items-center gap-1.5">
      {PHASE_DEFS.map(p => (
        <PhaseBadge key={p.key} short={p.short} state={phases[p.key]} label={p.label} />
      ))}
    </div>
  );
}

function PhaseBadge({ short, state, label }) {
  const palette = {
    pending:   { bg: 'var(--rl-bg-3)',         fg: 'var(--rl-ink-3)',   border: 'var(--rl-border)' },
    running:   { bg: 'var(--rl-primary-soft)', fg: 'var(--rl-primary)', border: 'var(--rl-primary)' },
    succeeded: { bg: 'var(--rl-teal-soft)',    fg: 'var(--rl-teal)',    border: 'var(--rl-teal)' },
    failed:    { bg: 'var(--rl-critical-soft)',fg: 'var(--rl-critical)',border: 'var(--rl-critical)' },
  }[state] || { bg: 'var(--rl-bg-3)', fg: 'var(--rl-ink-3)', border: 'var(--rl-border)' };

  return (
    <div
      className="font-mono text-[10px] font-medium flex items-center gap-1 px-1.5 py-0.5 rounded"
      style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.border}` }}
      title={`${label} · ${state}`}
    >
      {state === 'running' && <Loader2 size={9} className="animate-spin" />}
      {state === 'succeeded' && <CheckCircle2 size={9} />}
      {state === 'failed' && <AlertTriangle size={9} />}
      {(state === 'pending' || !state) && <Circle size={9} />}
      {short}
    </div>
  );
}

/* ----- Phase 결과 카드 (개별) ----- */
function PhaseStatusLine({ phaseKey, state, summary }) {
  const def = PHASE_DEFS.find(p => p.key === phaseKey);
  const stateLabel = {
    pending:   '대기',
    running:   '분석 중…',
    succeeded: '완료',
    failed:    '실패',
  }[state] || '대기';
  const stateColor = {
    pending:   'var(--rl-ink-3)',
    running:   'var(--rl-primary)',
    succeeded: 'var(--rl-teal)',
    failed:    'var(--rl-critical)',
  }[state] || 'var(--rl-ink-3)';

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <PhaseBadge short={def.short} state={state} label={def.label} />
      <span style={{ color: 'var(--rl-ink-2)' }}>{def.label}</span>
      <span className="ml-auto font-mono" style={{ color: stateColor }}>{stateLabel}</span>
      {summary && state === 'succeeded' && (
        <span className="text-[10px] truncate" style={{ color: 'var(--rl-ink-3)', maxWidth: 140 }}>· {summary}</span>
      )}
    </div>
  );
}

/* ============================================================
   LEFT PANEL · 입력 요약
   ============================================================ */
function WorkspaceLeftPanel({ patient, phases }) {
  // 환자 객체에서 가능한 만큼 끌어옴 + 시나리오 기반 가짜 HPO·Lab
  const hpoChips = derivePatientHPO(patient);
  const labs = derivePatientLabs(patient);

  return (
    <Panel title="입력 요약 · Patient Input" mono="LEFT · Panel #1" fill>
      <div className="flex flex-col gap-3 text-[12px]">
        {/* 주호소 */}
        <Section title="주호소" mono="Chief complaint">
          <div className="leading-snug" style={{ color: 'var(--rl-ink)' }}>
            <BiText>{patient.complaint}</BiText>
          </div>
        </Section>

        {/* HPO 칩 (Phase 1 결과) */}
        <Section
          title="추출된 HPO"
          mono={`Phase 1 · ${phases.phase1 || 'pending'}`}
          monoColor={phases.phase1 === 'succeeded' ? 'var(--rl-teal)' : 'var(--rl-ink-3)'}
        >
          {phases.phase1 === 'pending' || phases.phase1 === 'running' ? (
            <PhaseLoadingBlock state={phases.phase1} hint="임상노트 → HPO 추출 (Bedrock Haiku)" />
          ) : (
            <div className="flex flex-wrap gap-1">
              {hpoChips.map(h => (
                <span
                  key={h.code}
                  className="chip"
                  style={{ background: 'var(--rl-bg-3)', color: 'var(--rl-ink-2)', border: '1px solid var(--rl-border)' }}
                  title={h.code}
                >
                  {h.label}
                  <span className="font-mono text-[9px] ml-1" style={{ color: 'var(--rl-ink-3)' }}>
                    {h.code.replace('HP:', '')}
                  </span>
                </span>
              ))}
            </div>
          )}
        </Section>

        {/* Vitals */}
        <Section title="활력징후" mono="Vitals">
          <div className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--rl-ink-2)' }}>
            {patient.vitals || 'BP — · HR — · RR — · SpO₂ — · T —'}
          </div>
        </Section>

        {/* Lab */}
        <Section title="주요 검사" mono="Lab · highlights">
          <div className="flex flex-col gap-1">
            {labs.map(l => (
              <div key={l.name} className="flex items-baseline gap-2 text-[11px]">
                <span className="font-medium" style={{ color: 'var(--rl-ink)', minWidth: 60 }}>{l.name}</span>
                <span className="font-mono" style={{ color: l.flag === 'H' ? 'var(--rl-critical)' : l.flag === 'L' ? 'var(--rl-primary)' : 'var(--rl-ink-2)' }}>
                  {l.value}{l.unit ? ` ${l.unit}` : ''}
                </span>
                {l.flag && (
                  <span className="font-mono text-[9px] ml-auto" style={{ color: l.flag === 'H' ? 'var(--rl-critical)' : 'var(--rl-primary)' }}>
                    {l.flag}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>

        {/* Phase 진행 요약 (좌측 하단) */}
        <Section title="진행 상태" mono="Phase progress">
          <div className="flex flex-col gap-1.5">
            <PhaseStatusLine phaseKey="phase1" state={phases.phase1} summary={`${hpoChips.length} HPO`} />
            <PhaseStatusLine phaseKey="phase2" state={phases.phase2} summary="14 CheXpert label" />
            <PhaseStatusLine phaseKey="phase3" state={phases.phase3} summary="top-10 draft" />
            <PhaseStatusLine phaseKey="phase4" state={phases.phase4} summary="6-guardrail 통과" />
            <PhaseStatusLine phaseKey="phase5" state={phases.phase5} summary={patient.rare ? '희귀 후보 ↑' : 'rare 후보 없음'} />
            <PhaseStatusLine phaseKey="final"  state={phases.final}  summary="md 생성" />
          </div>
        </Section>
      </div>
    </Panel>
  );
}

/* ============================================================
   CENTER PANEL · CXR + Heatmap + 14 label
   ============================================================ */
function WorkspaceCenterPanel({ patient, phases, onRerunImage }) {
  const labels = deriveChexpertLabels(patient);
  const [selectedLabel, setSelectedLabel] = useState(null);

  // P2 succeeded 시점에 양성 라벨 중 score 최대 자동 선택 (없으면 null → "이상 없음").
  // 환자 바뀌거나 P2 재분석되면 다시 자동 선택.
  useEffect(() => {
    if (phases.phase2 === 'succeeded') {
      const positives = (labels || [])
        .filter(l => l.score >= 0.5)
        .sort((a, b) => b.score - a.score);
      setSelectedLabel(positives.length ? positives[0].name : null);
    } else {
      setSelectedLabel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient.mrn, phases.phase2]);

  const focalRegions = selectedLabel ? LABEL_FOCAL_REGIONS[selectedLabel] : null;

  function handleLabelClick(labelName, isPositive) {
    if (!isPositive) return;
    setSelectedLabel(prev => (prev === labelName ? null : labelName));
  }

  return (
    <Panel
      title="영상 + AI 추론 · Phase 2"
      mono={`CENTER · Panel #2 · ${phases.phase2 || 'pending'}`}
      fill
      right={
        <button
          onClick={onRerunImage}
          disabled={phases.phase2 === 'running'}
          className="text-[11px] font-medium flex items-center gap-1.5 px-2 py-1 rounded transition hover:opacity-90"
          style={{
            background: phases.phase2 === 'running' ? 'var(--rl-bg-3)' : 'var(--rl-amber-soft)',
            color: phases.phase2 === 'running' ? 'var(--rl-ink-3)' : 'var(--rl-amber)',
            cursor: phases.phase2 === 'running' ? 'wait' : 'pointer',
          }}
          title="P2부터 cascade로 다시 (P3·P4·P5·Final)"
        >
          <RefreshCw size={11} /> 이미지 재분석
        </button>
      }
    >
      <div className="h-full flex flex-col gap-2" style={{ minHeight: 0 }}>
        {/* CXR 2-up */}
        <div className="flex gap-2 flex-1" style={{ minHeight: 0 }}>
          <CxrFrame patient={patient} heatmap={false} caption="원본 · Original" />
          <CxrFrame
            patient={patient}
            heatmap={true}
            caption="Heatmap"
            focalRegions={focalRegions}
            labelName={selectedLabel}
          />
        </div>

        {/* 14 CheXpert label bar */}
        <div className="flex-shrink-0">
          {/* Header row — 높이 고정 · 한 줄 · 칩 등장으로도 위 이미지 영역 안 침범 */}
          <div
            className="flex items-center justify-between mb-1"
            style={{ height: 16, lineHeight: '16px', overflow: 'hidden' }}
          >
            <div
              className="font-mono text-[10px] uppercase tracking-widest"
              style={{
                color: 'var(--rl-ink-3)',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: '1 1 0',
              }}
            >
              14 CheXpert label · DenseNet-121
              {phases.phase2 === 'succeeded' && (
                <span className="normal-case tracking-normal ml-2" style={{ color: 'var(--rl-ink-3)' }}>
                  · 양성 label 클릭 시 heatmap 전환
                </span>
              )}
            </div>
            {phases.phase2 === 'running' && (
              <div className="flex items-center gap-1 text-[10px] flex-shrink-0" style={{ color: 'var(--rl-primary)' }}>
                <Loader2 size={10} className="animate-spin" /> SageMaker 추론 중…
              </div>
            )}
            {phases.phase2 === 'succeeded' && (
              <div className="flex items-center gap-2 text-[10px] flex-shrink-0" style={{ whiteSpace: 'nowrap' }}>
                {selectedLabel && (
                  <button
                    onClick={() => setSelectedLabel(null)}
                    className="font-mono hover:underline flex items-center gap-0.5"
                    style={{ color: 'var(--rl-amber)' }}
                    title="기본 heatmap으로 복귀"
                  >
                    <X size={9} /> {selectedLabel}
                  </button>
                )}
                <span style={{ color: 'var(--rl-teal)' }}>
                  {labels.filter(l => l.score >= 0.5).length}건 양성
                </span>
              </div>
            )}
          </div>

          {phases.phase2 === 'pending' || phases.phase2 === 'running' ? (
            <PhaseLoadingBlock state={phases.phase2} hint="SageMaker 엔드포인트 호출" />
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {labels.map(l => (
                <ChexpertBar
                  key={l.name}
                  {...l}
                  active={selectedLabel === l.name}
                  onClick={() => handleLabelClick(l.name, l.score >= 0.5)}
                  clickable={l.score >= 0.5}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ChexpertBar({ name, score, active = false, onClick, clickable = false }) {
  const positive = score >= 0.5;
  const color = positive ? 'var(--rl-critical)' : 'var(--rl-ink-3)';
  const isInteractive = clickable && onClick;

  return (
    <div
      onClick={isInteractive ? onClick : undefined}
      className={`flex items-center gap-2 text-[10px] rounded px-1 py-0.5 transition ${isInteractive ? 'cursor-pointer hover:bg-slate-50' : ''}`}
      style={{
        background: active ? 'var(--rl-amber-soft)' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px var(--rl-amber)' : 'none',
      }}
      title={isInteractive ? `클릭 → ${name} heatmap` : positive ? '양성' : '음성'}
    >
      <span className="truncate" style={{ color: positive ? 'var(--rl-ink)' : 'var(--rl-ink-3)', minWidth: 80, fontWeight: active ? 600 : 400 }}>
        {name}
      </span>
      <div className="flex-1 h-1 rounded" style={{ background: 'var(--rl-bg-3)', overflow: 'hidden' }}>
        <div className="h-full rounded" style={{ width: `${Math.round(score * 100)}%`, background: active ? 'var(--rl-amber)' : color }} />
      </div>
      <span className="font-mono w-7 text-right" style={{ color: active ? 'var(--rl-amber)' : color }}>
        {score.toFixed(2)}
      </span>
    </div>
  );
}

/* ============================================================
   RIGHT PANEL · 감별진단 + 희귀질환 + 최종 리포트
   ============================================================ */
function WorkspaceRightPanel({ patient, phases, onRerunRare, phase5Result = null, finalReport = null, reportState = 'idle' }) {
  const ranking = patient.preview || [];
  const verifiedColor = phases.phase4 === 'succeeded';
  // Backend Phase5 결과가 도착하면 listed_diseases 가 채워짐 — Robinson Fig.2 LR 막대로 렌더.
  // 그 외 (mock 시뮬레이션 또는 아직 미도착) 에는 기존 RareCardBody 유지.
  const hasBackendListing = Array.isArray(phase5Result?.listed_diseases) && phase5Result.listed_diseases.length > 0;

  return (
    <div className="flex flex-col gap-2 h-full" style={{ minHeight: 0, overflow: 'auto' }}>
      {/* 감별진단 순위 (Phase 3·4) — 일반/기타 질환만. 다중모달 통합 스코어 (LR 아님) */}
      <Panel
        title={verifiedColor ? '감별진단 순위 · LLM 검증 완료' : '감별진단 순위 · 검증 대기'}
        mono={`Phase 3·4 · 통합 스코어 · ${phases.phase4 || 'pending'}`}
        right={
          verifiedColor ? (
            <span className="chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
              <Shield size={10} /> 6-guardrail OK
            </span>
          ) : null
        }
      >
        {phases.phase4 === 'pending' || phases.phase4 === 'running' ? (
          <PhaseLoadingBlock state={phases.phase4} hint="Bedrock Sonnet 검증 중…" />
        ) : (() => {
          const commonRanking = ranking.filter(d => !d.rare);
          if (commonRanking.length === 0) {
            return (
              <div className="text-[11px] text-center py-4" style={{ color: 'var(--rl-ink-3)' }}>
                일반·기타 질환 후보 없음 — 입력 데이터 확인
              </div>
            );
          }
          return (
            <div className="flex flex-col gap-2">
              {commonRanking.slice(0, 6).map((dx, i) => (
                <RankingBar key={i} rank={i + 1} {...dx} />
              ))}
            </div>
          );
        })()}
      </Panel>

      {/* 희귀질환 listing (Phase 5) — 위의 감별진단 ranking 과 별개 영역.
          ranking = 일반 폐질환 (Phase 3/4 multimodal + verify)
          listing = LIRICAL LR > 5 만족하는 rare disease (Phase 5) */}
      <Panel
        title={hasBackendListing
          ? `희귀질환 listing · ${phase5Result.total_listed_count ?? phase5Result.listed_diseases.length}건 (LR > 5)`
          : '희귀질환 평가 · Phase 5'}
        mono={`P5 · ${phases.phase5 || 'pending'}${hasBackendListing ? ' · LIRICAL' : ''}`}
        right={
          <button
            onClick={onRerunRare}
            disabled={phases.phase5 === 'running'}
            className="text-[11px] font-medium flex items-center gap-1.5 px-2 py-1 rounded transition hover:opacity-90"
            style={{
              background: phases.phase5 === 'running' ? 'var(--rl-bg-3)' : 'var(--rl-rare-soft)',
              color: phases.phase5 === 'running' ? 'var(--rl-ink-3)' : 'var(--rl-rare)',
              cursor: phases.phase5 === 'running' ? 'wait' : 'pointer',
            }}
            title="P5 자체 가중치로 다시 (+ Final)"
          >
            <RefreshCw size={11} /> 희귀 재시도
          </button>
        }
      >
        {phases.phase5 === 'pending' || phases.phase5 === 'running' ? (
          <PhaseLoadingBlock state={phases.phase5} hint="376 rare DB + LIRICAL LR" />
        ) : hasBackendListing ? (
          <Phase5LRBars
            diseases={phase5Result.listed_diseases}
            topN={5}
            showEvidence={true}
            expandedDefault={0}
          />
        ) : (
          <RareCardBody patient={patient} ranking={ranking} />
        )}
      </Panel>

      {/* 최종 RAG 리포트 */}
      <Panel
        title="최종 임상소견서 · RAG"
        mono={`Final · ${phases.final || 'pending'}`}
        right={
          phases.final === 'succeeded' ? (
            <span className="chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
              <CheckCircle2 size={10} /> 준비됨
            </span>
          ) : null
        }
      >
        {phases.final === 'pending' || phases.final === 'running' ? (
          <PhaseLoadingBlock state={phases.final} hint="유사 케이스 5건 retrieve + Bedrock Sonnet 합성" />
        ) : (
          <FinalReportPreview
            patient={patient}
            ranking={ranking}
            finalReport={finalReport}
            reportState={reportState}
          />
        )}
      </Panel>
    </div>
  );
}

/* ----- 감별진단 순위 막대 (Phase 3·4 다중모달 통합 스코어) -----
 * 일반/기타 질환 전용. Likelihood Ratio (Robinson Fig.2 좌·우 막대) 양식이 아님 —
 * 단순 0~100% 통합 스코어 progress 막대. LR 막대는 희귀질환(Phase5LRBars) 전용. */
function RankingBar({ rank, name, prob, dontMiss, orpha }) {
  const scorePct = Math.round((prob || 0) * 100);
  return (
    <div
      className="px-2 py-1.5 rounded"
      style={{
        border: `1px solid ${dontMiss ? 'var(--rl-amber)' : 'var(--rl-border-soft)'}`,
        background: 'white',
      }}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <span className="font-mono text-[10px] w-4" style={{ color: 'var(--rl-ink-3)' }}>#{rank}</span>
        <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--rl-ink)' }}>
          <BiText>{name}</BiText>
        </span>
        {dontMiss && <AlertTriangle size={10} style={{ color: 'var(--rl-amber)' }} />}
        <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-2)' }}>
          {scorePct}%
        </span>
      </div>
      {/* 통합 스코어 막대 — 좌→우 progress (LR 양식 아님) */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[8px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>
          스코어
        </span>
        <div className="relative h-2 rounded flex-1" style={{ background: 'var(--rl-bg-3)' }}>
          <div
            className="absolute h-full rounded"
            style={{ left: 0, width: `${scorePct}%`, background: 'var(--rl-primary)' }}
          />
        </div>
      </div>
      {orpha && (
        <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--rl-ink-3)' }}>{orpha}</div>
      )}
    </div>
  );
}

/* ----- 희귀질환 카드 body ----- */
function RareCardBody({ patient, ranking }) {
  const rareList = ranking.filter(d => d.rare);
  if (rareList.length === 0) {
    return (
      <div className="text-[11px] py-3 text-center" style={{ color: 'var(--rl-ink-3)' }}>
        희귀질환 후보 없음 (top score &lt; trigger threshold)
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--rl-rare)' }}>
        <Flame size={11} /> 자체 가중치 (1·2·3 raw + 376 rare DB)
      </div>
      {rareList.map((d, i) => (
        <div key={i} className="hairline rounded p-2" style={{ background: 'var(--rl-rare-soft)', borderColor: 'var(--rl-rare)' }}>
          <div className="flex items-baseline gap-2">
            <span className="font-medium" style={{ color: 'var(--rl-rare)' }}>
              <BiText>{d.name}</BiText>
            </span>
            <span className="font-mono text-[10px] ml-auto" style={{ color: 'var(--rl-rare)' }}>
              {(d.prob * 100).toFixed(0)}%
            </span>
          </div>
          {d.orpha && (
            <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--rl-rare)' }}>{d.orpha}</div>
          )}
        </div>
      ))}
      <div className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--rl-ink-3)' }}>
        유전자 검사 추천 · 확진검사 계획은 리포트 탭에서 확인
      </div>
    </div>
  );
}

/* ----- 최종 리포트 미리보기 ----- */
function FinalReportPreview({ patient, ranking, finalReport = null, reportState = 'idle' }) {
  const top = ranking[0];
  const isReady = reportState === 'ready';

  // 전체 본문 보기 핸들러:
  //   1) diagnosis_json (구조화 진단 결과) → 의사 소견서 양식 새 창 (PDF 인쇄 가능)
  //   2) markdown_report → HTML 변환 후 새 창 (구버전 fallback)
  //   3) mock 모드 → 기존 openReportPopup
  // ※ RAG 의 s3_uri_pdf 는 내부가 plain text 라 쓰지 않음 — diagnosis_json 으로 직접 문서화.
  function handleOpenFull() {
    if (!isReady) return;
    if (finalReport?.diagnosis_json) {
      openClinicalReport(patient, finalReport);
      return;
    }
    const md = finalReport?.markdown_report || finalReport?.full_report_md;
    if (md) {
      openMarkdownPopup(patient, md, finalReport);
      return;
    }
    // backend 없으면 기존 mock 리포트 popup
    openReportPopup(patient);
  }

  return (
    <div className="text-[11px] leading-snug" style={{ color: 'var(--rl-ink-2)' }}>
      <div className="font-serif text-[12px] mb-1.5" style={{ color: 'var(--rl-ink)' }}>
        AI-Assisted 임상소견서 · 초안
      </div>
      <div className="mb-1.5">
        <span className="font-medium" style={{ color: 'var(--rl-ink)' }}>{patient.name}</span>{' '}
        ({patient.sex === 'M' ? '남' : '여'}/{patient.age}) — 주호소: <BiText>{patient.complaint}</BiText>
      </div>
      {finalReport?.final_dx ? (
        <div className="mb-1.5">
          <span style={{ color: 'var(--rl-ink-3)' }}>RAG 진단: </span>
          <span className="font-medium" style={{ color: 'var(--rl-primary)' }}>
            <BiText>{finalReport.final_dx}</BiText>
            {finalReport.confidence ? ` · ${finalReport.confidence}` : ''}
          </span>
        </div>
      ) : top && (
        <div className="mb-1.5">
          <span style={{ color: 'var(--rl-ink-3)' }}>가장 가능성 높은 진단: </span>
          <span className="font-medium" style={{ color: top.rare ? 'var(--rl-rare)' : 'var(--rl-primary)' }}>
            <BiText>{top.name}</BiText> ({(top.prob * 100).toFixed(0)}%)
          </span>
        </div>
      )}
      <div className="text-[10px] mb-2" style={{ color: 'var(--rl-ink-3)' }}>
        RAG · 유사 케이스 retrieve · Bedrock Sonnet 합성
        {finalReport?.rag_apis_used?.length ? ` · ${finalReport.rag_apis_used.length} APIs` : ''}
        {finalReport?.rag_citations?.length ? ` · 인용 ${finalReport.rag_citations.length}건` : ''}
      </div>
      <button
        className="text-[11px] font-medium flex items-center gap-1 hover:underline disabled:cursor-not-allowed disabled:no-underline"
        style={{
          color: isReady ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
          opacity: isReady ? 1 : 0.55,
        }}
        disabled={!isReady}
        onClick={handleOpenFull}
        title={isReady ? '전체 본문을 새 창에서 보기' : '리포트 생성 후 활성화됩니다'}
      >
        {isReady ? <>전체 본문 보기 <ArrowUpRight size={11} /></> : '리포트 미생성 · 대기 중'}
      </button>
    </div>
  );
}

/* markdown_report 를 새 창에 HTML 로 렌더 — 간단한 마크다운 → HTML 변환 */
function openMarkdownPopup(patient, markdown, finalReport = null) {
  const w = window.open('', `rpt-md-${patient.mrn}`, 'width=900,height=1100,resizable=yes,scrollbars=yes');
  if (!w) { alert('팝업 차단을 해제해주세요.'); return; }

  // 매우 가벼운 markdown → HTML (헤더 / 굵게 / 리스트 / 인용 / 코드)
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = (markdown || '').split('\n');
  const out = [];
  let inList = false, inCode = false;
  for (const raw of lines) {
    const ln = raw.replace(/\r$/, '');
    if (ln.startsWith('```')) { inCode = !inCode; out.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
    if (inCode) { out.push(esc(ln)); continue; }
    if (/^#{1,3}\s/.test(ln)) {
      if (inList) { out.push('</ul>'); inList = false; }
      const m = ln.match(/^(#{1,3})\s+(.*)$/);
      out.push(`<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`);
    } else if (/^\s*[-*]\s+/.test(ln)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${esc(ln.replace(/^\s*[-*]\s+/, ''))}</li>`);
    } else if (/^\s*\d+\.\s+/.test(ln)) {
      if (!inList) { out.push('<ol>'); inList = true; }
      out.push(`<li>${esc(ln.replace(/^\s*\d+\.\s+/, ''))}</li>`);
    } else if (ln.startsWith('>')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<blockquote>${esc(ln.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (ln.trim() === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<p></p>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      const inline = esc(ln)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
      out.push(`<p>${inline}</p>`);
    }
  }
  if (inList) out.push('</ul>');

  const cit = (finalReport?.rag_citations || []).map((c, i) => {
    const fields = [];
    if (c.disease_name)    fields.push(`<b>${esc(c.disease_name)}</b>`);
    if (c.pubmed_cases)    fields.push(`<div><span class="lbl">PubMed cases</span> ${esc(c.pubmed_cases)}</div>`);
    if (c.pubmed_guide)    fields.push(`<div><span class="lbl">Guideline</span> ${esc(c.pubmed_guide)}</div>`);
    if (c.clinical_trials) fields.push(`<div><span class="lbl">Clinical trials</span> ${esc(c.clinical_trials)}</div>`);
    if (c.title)           fields.push(`<b>${esc(c.title)}</b>${c.source ? ` · <span class="muted">${esc(c.source)}</span>` : ''}`);
    return `<div class="cit"><span class="mono">[${i+1}]</span> ${fields.join(' ')}</div>`;
  }).join('');

  const apis = (finalReport?.rag_apis_used || []).map(a => `<span class="chip">${esc(a)}</span>`).join('');
  const sex = patient.sex === 'M' ? '남' : '여';

  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<title>리포트 · ${esc(patient.name)} · ${esc(patient.mrn)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html,body{margin:0;padding:0;background:#F1F5F9;color:#0A1628;font-family:'IBM Plex Sans KR',sans-serif;-webkit-font-smoothing:antialiased;}
  .page{background:white;max-width:840px;margin:24px auto;padding:48px;border:1px solid #E2E8F0;box-shadow:0 4px 16px rgba(10,22,40,0.08);}
  .head{display:flex;align-items:baseline;gap:12px;padding-bottom:8px;border-bottom:2px solid #0C447C;margin-bottom:16px;}
  .head .name{font-family:'IBM Plex Serif',serif;font-size:20px;color:#083158;}
  .head .meta{margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#64748B;}
  .patient{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:12px;background:#F8FAFC;border:1px solid #E2E8F0;margin-bottom:14px;}
  .patient .lbl{font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;color:#64748B;letter-spacing:.15em;margin-bottom:3px;}
  .body h1{font-family:'IBM Plex Serif',serif;font-size:18px;border-bottom:1px solid #CBD5E1;padding-bottom:4px;margin-top:24px;}
  .body h2{font-family:'IBM Plex Sans KR',sans-serif;font-size:15px;color:#0C447C;margin-top:18px;}
  .body h3{font-family:'IBM Plex Sans KR',sans-serif;font-size:13px;color:#334155;margin-top:14px;}
  .body p{font-size:13px;line-height:1.7;margin:6px 0;}
  .body ul,.body ol{font-size:13px;line-height:1.7;padding-left:22px;margin:6px 0;}
  .body blockquote{border-left:3px solid #CBD5E1;padding:4px 12px;margin:8px 0;color:#475569;font-style:italic;}
  .body code{font-family:'IBM Plex Mono',monospace;font-size:12px;background:#F1F5F9;padding:1px 4px;border-radius:3px;}
  .body pre{background:#F1F5F9;padding:10px;border-radius:4px;overflow:auto;}
  .cits{margin-top:24px;padding-top:12px;border-top:1px solid #CBD5E1;}
  .cits h2{font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.15em;color:#64748B;margin:0 0 8px;}
  .cit{font-size:12px;line-height:1.6;margin:8px 0;padding:8px;background:#F8FAFC;border-left:3px solid #0C447C;}
  .cit .mono{font-family:'IBM Plex Mono',monospace;font-size:11px;color:#64748B;margin-right:6px;}
  .cit .lbl{font-family:'IBM Plex Mono',monospace;font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:.1em;margin-right:4px;}
  .apis{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;}
  .chip{font-family:'IBM Plex Mono',monospace;font-size:10px;background:#E0F2FE;color:#075985;padding:2px 8px;border-radius:12px;}
  .footer{margin-top:24px;padding-top:10px;border-top:1px solid #E2E8F0;font-size:11px;color:#64748B;}
  .warn{color:#B45309;font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.15em;}
  .muted{color:#64748B;}
  @media print{body{background:white}.page{margin:0;border:none;box-shadow:none}}
</style></head><body>
<div class="page">
  <div class="head">
    <div class="name">Soo-Pul · 임상소견서</div>
    <div class="meta">${esc((finalReport?.generated_at || '').toString().slice(0,19))} · ${esc(finalReport?.llm_model || '')}</div>
  </div>
  <div class="patient">
    <div><div class="lbl">환자명</div><div>${esc(patient.name)}</div></div>
    <div><div class="lbl">성별/나이</div><div>${esc(sex)} / ${esc(String(patient.age))}</div></div>
    <div><div class="lbl">MRN</div><div style="font-family:'IBM Plex Mono',monospace">${esc(patient.mrn)}</div></div>
    <div><div class="lbl">주호소</div><div>${esc(patient.complaint || '')}</div></div>
  </div>
  <div class="body">${out.join('\n')}</div>
  ${cit ? `<div class="cits"><h2>RAG Citations (${(finalReport?.rag_citations || []).length})</h2>${cit}</div>` : ''}
  ${apis ? `<div class="apis">${apis}</div>` : ''}
  <div class="footer">
    <div class="warn">본 리포트의 AI 분석 결과는 진단 보조용입니다.</div>
    <div style="margin-top:4px">최종 진단 및 치료 결정은 반드시 주치의의 임상적 판단에 따라야 합니다. [EU AI Act Art. 22]</div>
    <div style="margin-top:4px" class="muted">session: ${esc(finalReport?.session_id || '')}</div>
  </div>
</div>
</body></html>`);
  w.document.close();
}

/* ───────────────────────────────────────────────────────────────
   근거 식별자 → 외부 DB 하이퍼링크.
   PMID  → PubMed,  NCT → ClinicalTrials.gov,  ORPHA → Orphanet.
   리포트 본문·권고·인용에서 유사 증례 / 임상시험 / 희귀질환을 바로 열람.
   ─────────────────────────────────────────────────────────────── */
const EVIDENCE_RE = /(PMID:?\s*\d{5,9}|NCT\d{8}|ORPHA:?\s*\d+)/gi;

function evidenceUrl(token) {
  let m;
  if ((m = token.match(/PMID:?\s*(\d+)/i)))  return `https://pubmed.ncbi.nlm.nih.gov/${m[1]}/`;
  if ((m = token.match(/(NCT\d{8})/i)))       return `https://clinicaltrials.gov/study/${m[1].toUpperCase()}`;
  if ((m = token.match(/ORPHA:?\s*(\d+)/i)))  return `https://www.orpha.net/en/disease/detail/${m[1]}`;
  return null;
}

/* HTML 문자열용 — 이미 esc() 된 텍스트에 <a> 삽입 (openClinicalReport). */
function linkifyHtml(escapedText) {
  return String(escapedText || '').replace(EVIDENCE_RE, (tok) => {
    const url = evidenceUrl(tok);
    return url
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="evlink">${tok}</a>`
      : tok;
  });
}

/* 식별자 종류 라벨. */
function evidenceType(token) {
  if (/PMID/i.test(token))  return 'PubMed';
  if (/NCT/i.test(token))   return 'ClinicalTrials.gov';
  if (/ORPHA/i.test(token)) return 'Orphanet';
  return '출처';
}

/* diagnosis_json 본문 + (옵션) RAG 원문을 훑어 PMID/NCT/ORPHA 출처를 중복 없이 수집.
   RAG 가 rag_citations 배열을 비워 보내도, 본문에 산재한 근거를 출처 리스트로 만든다.
   diagnosis_json 에 식별자가 없는 세션을 대비해 markdown_report 원문도 함께 스캔한다. */
function collectEvidence(dj, ...extraTexts) {
  const seen = new Set();
  const list = [];
  const scan = (text) => {
    String(text == null ? '' : text).replace(EVIDENCE_RE, (tok) => {
      const norm = tok.replace(/\s+/g, '').toUpperCase();
      if (!seen.has(norm)) { seen.add(norm); list.push(tok.trim()); }
      return tok;
    });
  };
  if (dj) {
    const cn = dj.clinical_notes || {};
    Object.values(cn).forEach(scan);
    const rec = dj.recommendation || {};
    Object.values(rec).forEach(v => Array.isArray(v) ? v.forEach(scan) : scan(v));
    const cm = dj.confidence_metrics || {};
    scan(cm.rationale);
  }
  extraTexts.forEach(scan);
  // PubMed → ClinicalTrials → Orphanet 순 정렬
  const order = { PubMed: 0, 'ClinicalTrials.gov': 1, Orphanet: 2, 출처: 3 };
  return list.sort((a, b) => order[evidenceType(a)] - order[evidenceType(b)]);
}

/* React용 — 텍스트를 토큰화해 식별자만 <a> 로 (BackendReportView). */
function renderLinkedText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const out = [];
  let last = 0, m, key = 0;
  const re = new RegExp(EVIDENCE_RE.source, 'gi');
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const url = evidenceUrl(m[0]);
    out.push(url
      ? <a key={key++} href={url} target="_blank" rel="noopener noreferrer"
           style={{ color: 'var(--rl-primary)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{m[0]}</a>
      : m[0]);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/* 최종 보고서 Ⅴ. 희귀질환 listing 행 — 백엔드 Phase 5(listed_diseases) 우선,
   미도착 시 Overview·워크스페이스와 동일하게 환자 preview 의 rare 후보로 폴백한다.
   (Overview DxRankingSplit 도 patient.preview 의 rare 항목을 listing 으로 표시 →
    보고서만 backend phase5 만 보면 Overview 엔 떠도 보고서엔 안 나오는 불일치 발생.) */
function phase5ListingRows(patient, phase5) {
  const backend = (phase5 && Array.isArray(phase5.listed_diseases)) ? phase5.listed_diseases : [];
  if (backend.length) {
    return backend.slice(0, 10).map(d => ({
      name:  d.name || d.disease_name || '',
      value: String(d.lr_score ?? d.top_lr ?? '—'),
      orpha: d.orpha_code || d.orphacode || '—',
      source: 'backend',
    }));
  }
  return (patient.preview || []).filter(d => d.rare).slice(0, 10).map(d => ({
    name:  d.name || '',
    value: Number.isFinite(d.prob) ? `${Math.round(d.prob * 100)}%` : '—',
    orpha: d.orpha || '—',
    source: 'preview',
  }));
}

/* ───────────────────────────────────────────────────────────────
   임상 소견서 — diagnosis_json(구조화 진단 결과)을 의무기록 양식으로 렌더.
   RAG 의 markdown_report 는 빈약한 HTML 이라 쓰지 않고, diagnosis_json 의
   clinical_notes / recommendation / confidence_metrics 를 직접 문서화한다.
   새 창 → 상단 "PDF 저장 / 인쇄" 버튼 → window.print() (인쇄 시 버튼 숨김).
   ─────────────────────────────────────────────────────────────── */
function openClinicalReport(patient, finalReport, opts = {}) {
  const { phase3 = null, phase5 = null } = opts;
  const w = window.open('', `rpt-clin-${patient.mrn}`, 'width=920,height=1180,resizable=yes,scrollbars=yes');
  if (!w) { alert('팝업 차단을 해제해주세요.'); return; }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let dj = finalReport?.diagnosis_json;
  if (typeof dj === 'string') { try { dj = JSON.parse(dj); } catch (_) { dj = null; } }
  const cn  = (dj && dj.clinical_notes)      || {};
  const rec = (dj && dj.recommendation)      || {};
  const cm  = (dj && dj.confidence_metrics)  || {};

  const sex = patient.sex === 'M' ? '남' : '여';
  const gen = (finalReport?.generated_at || '').toString().slice(0, 19).replace('T', ' ');

  // ── 흉부 X-ray — 원본은 무조건, heatmap 은 분석상태에 따라 ──
  const studies = normalizeCxrStudies(patient);
  const study0  = studies[0] || null;
  const imgUrl  = study0 && study0.imageUrl ? `${window.location.origin}${study0.imageUrl}` : null;
  const cxrAnalyzed = patient.status === 'ready';
  const cxrPos  = deriveChexpertLabels(patient).filter(l => l.score >= 0.5);
  const topCxr  = cxrPos[0] || null;
  const origCell = imgUrl
    ? `<img src="${imgUrl}" alt="원본 흉부 X-ray" class="cxr-pic" />`
    : `<div class="cxr-svg">${buildCxrSvg({ heatmap: false })}</div>`;
  let heatCell, heatCap;
  if (!cxrAnalyzed) {
    heatCell = `<div class="cxr-state"><div class="st-t">분석 정보 없음</div><div class="st-s">CXR AI 분석 미완료</div></div>`;
    heatCap = '—';
  } else if (!topCxr) {
    heatCell = `<div class="cxr-state ok"><div class="st-t">이상 없음</div><div class="st-s">양성 소견 없음 · 모든 label &lt; 50%</div></div>`;
    heatCap = '이상 없음';
  } else {
    const svg = buildCxrSvg({ heatmap: true, labelName: topCxr.name, focalRegions: LABEL_FOCAL_REGIONS[topCxr.name] || null });
    heatCell = imgUrl
      ? `<div class="cxr-overlay"><img src="${imgUrl}" class="cxr-pic" /><div class="cxr-hm">${svg}</div></div>`
      : `<div class="cxr-svg">${svg}</div>`;
    heatCap = `${esc(topCxr.name)} · ${Math.round(topCxr.score * 100)}%`;
  }

  // ── 감별진단 순위 (Phase 3·4) / 희귀질환 listing (Phase 5) ──
  const p3list = (phase3 && Array.isArray(phase3.top_candidates)) ? phase3.top_candidates : [];
  const rankingHtml = p3list.length
    ? `<table class="rk"><thead><tr><th>순위</th><th>질환</th><th class="r">통합 스코어</th></tr></thead><tbody>${
        p3list.slice(0, 10).map((c, i) => {
          const v = Number(c.lr_score);
          const nm = `${esc(c.name)}${c.name_en ? `<div class="en">${esc(c.name_en)}</div>` : ''}`;
          return `<tr><td class="mono">#${i + 1}</td><td>${nm}</td><td class="r mono">${
            Number.isFinite(v) ? Math.round(v * 100) + '%' : '—'}</td></tr>`;
        }).join('')
      }</tbody></table>`
    : `<p class="empty">감별진단 순위 데이터 없음</p>`;
  const p5thr  = (phase5 && phase5.listing_criteria && phase5.listing_criteria.threshold_lr) || 5;
  const p5rows = phase5ListingRows(patient, phase5);
  const listingHtml = p5rows.length
    ? `<table class="rk"><thead><tr><th>순위</th><th>희귀질환</th><th class="r">LR</th><th>ORPHA</th></tr></thead><tbody>${
        p5rows.map((d, i) => `<tr><td class="mono">#${i + 1}</td><td>${
          esc(d.name)}</td><td class="r mono">${
          esc(d.value)}</td><td class="mono">${esc(d.orpha)}</td></tr>`).join('')
      }</tbody></table>`
    : `<p class="empty">LIRICAL Likelihood Ratio &gt; ${esc(p5thr)} 임계를 만족하는 희귀질환 없음</p>`;

  // 본문 섹션 — 근거 식별자(PMID/NCT/ORPHA)는 하이퍼링크
  const sect = (no, title, body) =>
    body ? `<section><h2><span class="no">${no}</span> ${esc(title)}</h2><p>${linkifyHtml(esc(body))}</p></section>` : '';

  const recBlock = (label, arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const items = arr.map(x => `<li>${linkifyHtml(esc(x))}</li>`).join('');
    return `<div class="rec"><div class="rec-h">${esc(label)}</div><ul>${items}</ul></div>`;
  };

  const score = Number(cm.overall_confidence_score);
  const hasScore = Number.isFinite(score);
  const sLabel = !hasScore ? '—' : score >= 0.75 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : 'LOW';
  const sColor = !hasScore ? '#64748B' : score >= 0.75 ? '#0E8574' : score >= 0.5 ? '#B45309' : '#B91C1C';
  const ds = cm.data_sufficiency || {};
  const dsRow = (k, v) => v
    ? `<div class="ds"><span class="ds-k">${esc(k)}</span><span class="ds-v ds-${esc(String(v).toLowerCase())}">${esc(v)}</span></div>` : '';

  // ── 참고 출처 — 논문 reference 양식으로 통일 ──
  const refOrg = {
    'PubMed': 'U.S. National Library of Medicine',
    'ClinicalTrials.gov': 'U.S. National Institutes of Health',
    'Orphanet': 'INSERM · Orphanet',
  };
  const collected = collectEvidence(dj, finalReport && (finalReport.markdown_report || finalReport.full_report_md));
  const refItems = collected.map((tok, i) => {
    const url = evidenceUrl(tok);
    const ty  = evidenceType(tok);
    const org = refOrg[ty] || '';
    const avail = url
      ? `Available from: <a href="${url}" target="_blank" rel="noopener noreferrer" class="evlink">${esc(url)}</a>`
      : '';
    return `<li class="ref"><span class="rn">${i + 1}.</span><span class="rbody">${esc(ty)}${
      org ? ` (${esc(org)})` : ''}. ${esc(tok)}. ${avail}</span></li>`;
  }).join('');

  const apis = (finalReport?.rag_apis_used || []).map(a => `<span class="chip">${esc(a)}</span>`).join('');

  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<title>임상소견서 · ${esc(patient.name)} · ${esc(patient.mrn)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  :root{--ink:#0A1628;--ink2:#334155;--ink3:#64748B;--line:#CBD5E1;--soft:#F1F5F9;--navy:#0C447C;--navy-d:#083158;}
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:#E2E8F0;color:var(--ink);font-family:'IBM Plex Sans KR',sans-serif;-webkit-font-smoothing:antialiased;}
  .toolbar{position:sticky;top:0;z-index:10;background:#0A1628;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;}
  .toolbar .t{font-size:12px;color:#94A3B8;font-family:'IBM Plex Mono',monospace;}
  .toolbar button{margin-left:auto;background:var(--navy);color:#fff;border:none;padding:8px 18px;font-size:13px;font-weight:600;border-radius:4px;cursor:pointer;font-family:inherit;}
  .toolbar button:hover{opacity:.9;}
  /* A4 문서 — 화면에선 페이지 경계가 보이게 doc 단위로 */
  .doc{background:#fff;width:210mm;margin:20px auto;padding:18mm 16mm;box-shadow:0 6px 24px rgba(10,22,40,.18);}
  .dochead{display:flex;align-items:flex-start;border-bottom:3px solid var(--navy);padding-bottom:10px;}
  .dochead .org{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.18em;color:var(--navy);text-transform:uppercase;}
  .dochead h1{font-family:'IBM Plex Serif',serif;font-size:23px;color:var(--navy-d);margin:3px 0 0;letter-spacing:-.01em;}
  .dochead .issue{margin-left:auto;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--ink3);line-height:1.7;}
  .pt{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);margin-top:14px;}
  .pt > div{padding:8px 10px;border-right:1px solid var(--line);}
  .pt > div:last-child{border-right:none;}
  .pt .k{font-family:'IBM Plex Mono',monospace;font-size:8.5px;text-transform:uppercase;letter-spacing:.13em;color:var(--ink3);margin-bottom:3px;}
  .pt .v{font-size:13px;font-weight:500;}
  section{margin-top:16px;break-inside:avoid;}
  section h2{font-size:13.5px;font-weight:600;color:var(--navy);margin:0 0 5px;padding-bottom:3px;border-bottom:1px solid var(--line);}
  section h2 .no{font-family:'IBM Plex Mono',monospace;color:var(--navy);margin-right:4px;}
  section p{font-size:12px;line-height:1.75;margin:0;color:var(--ink2);white-space:pre-wrap;}
  /* CXR 영상 */
  .cxr-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;}
  .cxr-cell{break-inside:avoid;}
  .cxr-cap{font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink3);margin-bottom:3px;}
  .cxr-box{aspect-ratio:1/1;background:#0A1628;border:1px solid var(--line);position:relative;overflow:hidden;}
  .cxr-pic{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#0A1628;}
  .cxr-svg{position:absolute;inset:0;}
  .cxr-overlay{position:absolute;inset:0;}
  .cxr-hm{position:absolute;inset:0;opacity:.55;}
  .cxr-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
  .cxr-state .st-t{color:rgba(255,255,255,.92);font-size:14px;}
  .cxr-state .st-s{font-family:'IBM Plex Mono',monospace;font-size:9px;color:rgba(255,255,255,.5);margin-top:4px;}
  .cxr-state.ok .st-t{color:#34D399;}
  /* ranking / listing 표 */
  table.rk{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:5px;}
  table.rk th{text-align:left;padding:5px 8px;background:var(--soft);border-bottom:1px solid var(--line);font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink3);}
  table.rk td{padding:5px 8px;border-bottom:1px solid var(--line);color:var(--ink2);}
  table.rk .r{text-align:right;}
  table.rk .mono{font-family:'IBM Plex Mono',monospace;}
  table.rk .en{font-size:9.5px;color:var(--ink3);font-style:italic;margin-top:1px;}
  .empty{font-size:11.5px;color:var(--ink3);padding:8px;background:var(--soft);border-radius:3px;margin-top:5px;}
  /* 권고 */
  .recwrap{margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;}
  .rec{break-inside:avoid;}
  .rec-h{font-size:11px;font-weight:600;color:var(--navy-d);background:var(--soft);padding:3px 8px;border-left:3px solid var(--navy);}
  .rec ul{margin:4px 0 0;padding-left:18px;}
  .rec li{font-size:11.5px;line-height:1.6;color:var(--ink2);}
  /* 신뢰도 */
  .conf{margin-top:6px;display:flex;gap:14px;align-items:flex-start;break-inside:avoid;}
  .score{flex-shrink:0;text-align:center;border:1px solid var(--line);padding:8px 14px;}
  .score .big{font-family:'IBM Plex Serif',serif;font-size:26px;line-height:1;}
  .score .lab{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.13em;margin-top:3px;}
  .ds{display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px dotted var(--line);}
  .ds-k{color:var(--ink3);}
  .ds-v{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:1px 7px;border-radius:10px;}
  .ds-high{background:#E6F5F2;color:#0E8574;} .ds-medium{background:#FEF3C7;color:#B45309;} .ds-low{background:#FEE2E2;color:#B91C1C;}
  /* 참고 출처 — 논문 reference 양식 */
  .refs{margin-top:16px;padding-top:8px;border-top:1px solid var(--line);break-inside:avoid;}
  .refs .ch{font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.13em;color:var(--ink3);margin-bottom:8px;}
  ol.reflist{margin:0;padding:0;list-style:none;}
  .ref{display:flex;gap:6px;font-size:10.5px;line-height:1.65;color:var(--ink2);margin:4px 0;break-inside:avoid;}
  .ref .rn{font-family:'IBM Plex Mono',monospace;color:var(--ink3);flex-shrink:0;min-width:20px;}
  .ref .rbody{flex:1;}
  .ref-empty{font-size:10.5px;color:var(--ink3);line-height:1.6;}
  .apis{margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;}
  .chip{font-family:'IBM Plex Mono',monospace;font-size:9px;background:#E0F2FE;color:#075985;padding:2px 8px;border-radius:10px;}
  .foot{margin-top:22px;padding-top:10px;border-top:2px solid var(--navy);break-inside:avoid;}
  .disc{background:#FEF3C7;border:1px solid #FCD34D;padding:8px 10px;font-size:10.5px;color:#92400E;line-height:1.6;}
  .disc b{color:#B45309;}
  .sign{margin-top:16px;display:flex;justify-content:flex-end;gap:40px;}
  .sign .box{text-align:center;}
  .sign .line{width:150px;border-bottom:1px solid var(--ink);margin-bottom:4px;height:34px;}
  .sign .cap{font-size:10px;color:var(--ink3);font-family:'IBM Plex Mono',monospace;}
  .muted{color:var(--ink3);}
  .evlink{color:var(--navy);text-decoration:underline;text-underline-offset:2px;}
  .evlink:hover{color:#1565C0;}
  /* 인쇄 — A4 페이지, 섹션이 페이지 경계에서 잘리지 않게 */
  @page{size:A4;margin:14mm 13mm;}
  @media print{
    body{background:#fff;}
    .toolbar{display:none;}
    .doc{margin:0;width:auto;box-shadow:none;padding:0;}
    section,.rec,.cit,.ref,.conf,.cxr-cell,.foot{break-inside:avoid;}
    .pagebreak{break-before:page;}
    .evlink{color:var(--navy);}
  }
</style></head><body>
  <div class="toolbar">
    <span class="t">CLINICAL REPORT · ${esc(patient.mrn)}</span>
    <button onclick="window.print()">PDF 로 저장 / 인쇄</button>
  </div>
  <div class="doc">
    <div class="dochead">
      <div>
        <div class="org">Soo-Pul · SooNet-Pulmonary Clinical Decision Support</div>
        <h1>AI 기반 임상소견서</h1>
      </div>
      <div class="issue">
        발급일시 ${esc(gen || '—')}<br/>
        모델 ${esc(finalReport?.llm_model || '—')}<br/>
        Session ${esc((finalReport?.session_id || '').toString().slice(0, 8))}
      </div>
    </div>

    <div class="pt">
      <div><div class="k">환자명</div><div class="v">${esc(patient.name)}</div></div>
      <div><div class="k">등록번호 (MRN)</div><div class="v" style="font-family:'IBM Plex Mono',monospace">${esc(patient.mrn)}</div></div>
      <div><div class="k">성별 / 나이</div><div class="v">${esc(sex)} / ${esc(String(patient.age))}세</div></div>
      <div><div class="k">주호소</div><div class="v">${esc(patient.complaint || '—')}</div></div>
    </div>

    <section>
      <h2><span class="no">Ⅰ.</span> 흉부 X-ray 영상 소견</h2>
      <div class="cxr-row">
        <div class="cxr-cell">
          <div class="cxr-cap">원본 · Original</div>
          <div class="cxr-box">${origCell}</div>
        </div>
        <div class="cxr-cell">
          <div class="cxr-cap">Heatmap · ${heatCap}</div>
          <div class="cxr-box">${heatCell}</div>
        </div>
      </div>
    </section>

    ${sect('Ⅱ.', '임상 요약', cn.summary)}
    ${sect('Ⅲ.', '주진단 추론', cn.top1_reasoning)}

    <section>
      <h2><span class="no">Ⅳ.</span> 감별진단 순위 · Phase 3·4 다중모달 통합 스코어</h2>
      ${rankingHtml}
    </section>
    <section>
      <h2><span class="no">Ⅴ.</span> 희귀질환 listing · Phase 5 LIRICAL Likelihood Ratio</h2>
      ${listingHtml}
    </section>

    ${sect('Ⅵ.', '감별진단', cn.differential_note)}
    ${sect('Ⅶ.', '유사 증례 비교', cn.case_comparison)}
    ${sect('Ⅷ.', '진단 근거 (RAG)', cn.rag_evidence)}
    ${sect('Ⅸ.', '역학 정보', cn.epidemiology_note)}

    ${(rec && Object.keys(rec).length) ? `
    <section>
      <h2><span class="no">Ⅹ.</span> 권고 사항</h2>
      <div class="recwrap">
        ${recBlock('즉시 시행 검사', rec.immediate_workup)}
        ${recBlock('추가 검사', rec.additional_lab)}
        ${recBlock('유전자 검사', rec.genetic_test)}
        ${recBlock('전문의 의뢰', rec.specialist_referral)}
        ${recBlock('치료 가이드라인', rec.treatment_guideline)}
        ${recBlock('임상시험 정보', rec.clinical_trial_info)}
      </div>
    </section>` : ''}

    ${(cm && Object.keys(cm).length) ? `
    <section>
      <h2><span class="no">Ⅺ.</span> 신뢰도 평가</h2>
      <div class="conf">
        <div class="score">
          <div class="big" style="color:${sColor}">${hasScore ? Math.round(score * 100) : '—'}<span style="font-size:13px">${hasScore ? '%' : ''}</span></div>
          <div class="lab" style="color:${sColor}">${sLabel}</div>
        </div>
        <div style="flex:1">
          ${dsRow('유전체 근거', ds.genomic_evidence)}
          ${dsRow('임상시험 가용성', ds.trial_availability)}
          ${dsRow('유사 증례 일치도', ds.clinical_case_match)}
          ${cm.rationale ? `<p style="font-size:11px;line-height:1.65;color:var(--ink2);margin:6px 0 0;">${linkifyHtml(esc(cm.rationale))}</p>` : ''}
        </div>
      </div>
    </section>` : ''}

    <div class="refs">
      <div class="ch">참고 출처 · References (${collected.length})</div>
      ${refItems
        ? `<ol class="reflist">${refItems}</ol>`
        : `<div class="ref-empty">본 리포트는 외부 의학 데이터베이스${
            apis ? ` (${(finalReport?.rag_apis_used || []).join(' · ')})` : ' (PubMed · Monarch · ClinicalTrials.gov · PubCaseFinder)'
          }를 조회해 작성되었습니다. 개별 인용 식별자(PMID·NCT·ORPHA)는 본문에 표기됩니다.</div>`}
    </div>
    ${apis ? `<div class="apis">${apis}</div>` : ''}

    <div class="foot">
      <div class="disc">
        <b>⚠ AI 보조 진단 — 본 소견서는 진단 보조 목적입니다.</b><br/>
        ${esc(cn.disclaimer || '최종 진단 및 치료 결정은 반드시 주치의의 임상적 판단과 추가 검사 결과를 종합하여 확정합니다.')} [EU AI Act Art. 22]
      </div>
      <div class="sign">
        <div class="box"><div class="line"></div><div class="cap">판독 / 확인 의사</div></div>
        <div class="box"><div class="line"></div><div class="cap">서명 / 날짜</div></div>
      </div>
    </div>
  </div>
</body></html>`);
  w.document.close();
}

/* ----- 공용 Section · Phase loading block ----- */
function Section({ title, mono, monoColor, children }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <div className="text-[11px] font-medium" style={{ color: 'var(--rl-ink-2)' }}>{title}</div>
        <div className="font-mono text-[9px] uppercase tracking-widest ml-auto" style={{ color: monoColor || 'var(--rl-ink-3)' }}>
          {mono}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ----- EMR 연동 시연 overlay (?demo=1 모드) ----- */
const EMR_STAGES = [
  { key: 'basic',  label: '환자 기본 정보',    sub: '이름 · MRN · 나이 · 성별 · 알러지' },
  { key: 'vitals', label: '활력 징후',          sub: 'BP · HR · RR · SpO₂ · Temp' },
  { key: 'labs',   label: '검사 결과',          sub: 'CBC · Chem · ABG · Inflammation' },
  { key: 'cxr',    label: '흉부 X-ray',         sub: 'DICOM → 448 resized · 영상의학과 판독' },
  { key: 'notes',  label: '임상 노트',          sub: 'Chief complaint · HPI · 진찰소견' },
];

function EmrLoadOverlay({ patient, stage, onLoad, onReset }) {
  const isStarted = stage > 0;
  const isLoading = stage > 0 && stage < 6;
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center"
      style={{
        // 완전 불투명 — EMR 불러오기 전/중에는 뒤의 환자 데이터가 보이지 않아야
        // "아직 데이터가 안 들어왔다" 는 상태가 명확하게 전달됨.
        background:
          'repeating-linear-gradient(135deg, var(--rl-bg-2) 0px, var(--rl-bg-2) 22px, var(--rl-bg-3) 22px, var(--rl-bg-3) 23px)',
      }}
    >
      <div
        className="bg-white"
        style={{
          maxWidth: 560, width: '90%',
          border: '1px solid var(--rl-border)',
          borderTop: '4px solid var(--rl-primary)',
          boxShadow: '0 10px 40px rgba(10,22,40,0.18)',
          padding: 32,
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <Database size={16} style={{ color: 'var(--rl-primary)' }} />
          <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
            EMR Integration · SMART on FHIR
          </span>
        </div>
        <h2 className="font-serif" style={{ fontSize: 22, color: 'var(--rl-ink)', marginBottom: 8 }}>
          {patient.name} <span style={{ color: 'var(--rl-ink-3)', fontSize: 14 }}>({patient.mrn})</span>
        </h2>
        <p className="text-[12px]" style={{ color: 'var(--rl-ink-3)', marginBottom: 20, lineHeight: 1.5 }}>
          {isStarted
            ? 'EMR 시스템에서 환자 정보를 가져오는 중입니다 …'
            : '데모 시연 — 의료 정보 시스템(EMR)에서 환자의 임상 데이터를 가져옵니다. 모든 데이터가 도착하면 AI 분석이 자동으로 시작됩니다.'}
        </p>

        {/* 5-stage progress */}
        <div className="space-y-2 mb-6">
          {EMR_STAGES.map((s, i) => {
            const idx = i + 1;  // 1..5
            const state = stage > idx ? 'done' : stage === idx ? 'loading' : 'pending';
            return (
              <div
                key={s.key}
                className="flex items-center gap-3"
                style={{
                  padding: '10px 12px',
                  border: '1px solid',
                  borderColor: state === 'done' ? 'var(--rl-teal)' : state === 'loading' ? 'var(--rl-primary)' : 'var(--rl-border-soft)',
                  background: state === 'done' ? 'var(--rl-teal-soft)' : state === 'loading' ? 'var(--rl-primary-soft)' : 'transparent',
                  borderRadius: 4,
                  transition: 'all 0.3s ease',
                }}
              >
                <div
                  style={{
                    width: 20, height: 20, borderRadius: '50%',
                    background: state === 'done' ? 'var(--rl-teal)' : state === 'loading' ? 'var(--rl-primary)' : 'var(--rl-bg-3)',
                    color: 'white',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {state === 'done' ? <CheckCircle2 size={12} />
                   : state === 'loading' ? <Loader2 size={12} className="animate-spin" />
                   : <Circle size={10} style={{ color: 'var(--rl-ink-3)', fill: 'none' }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium" style={{ color: state === 'pending' ? 'var(--rl-ink-3)' : 'var(--rl-ink)' }}>
                    {s.label}
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: 'var(--rl-ink-3)' }}>{s.sub}</div>
                </div>
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{
                  color: state === 'done' ? 'var(--rl-teal)' : state === 'loading' ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
                }}>
                  {state === 'done' ? '완료' : state === 'loading' ? '수신중' : '대기'}
                </div>
              </div>
            );
          })}
        </div>

        {/* 액션 버튼 */}
        {!isStarted ? (
          <button
            onClick={onLoad}
            className="w-full py-3 text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90"
            style={{ background: 'var(--rl-primary)', color: 'white', borderRadius: 4 }}
          >
            <Zap size={16} /> EMR 에서 환자 정보 불러오기
          </button>
        ) : isLoading ? (
          <div className="flex items-center justify-center gap-2 py-3 text-[12px]" style={{ color: 'var(--rl-ink-3)' }}>
            <Loader2 size={14} className="animate-spin" /> 데이터 수신 중 · {stage}/5
          </div>
        ) : null}

        {isStarted && (
          <button
            onClick={onReset}
            className="w-full py-2 text-[11px] font-medium mt-2 hover:underline"
            style={{ color: 'var(--rl-ink-3)' }}
          >
            처음으로 (리셋)
          </button>
        )}

        <div className="text-[10px] mt-4 pt-3" style={{ color: 'var(--rl-ink-3)', borderTop: '1px solid var(--rl-border-soft)' }}>
          <span className="font-mono uppercase tracking-widest" style={{ color: 'var(--rl-amber)' }}>Demo</span>{' '}
          실제 EMR (Epic / Cerner / BESTCare) 연동 시 같은 단계를 거칩니다. 모든 데이터 로딩 완료 시 AI 분석이 자동으로 시작됩니다.
        </div>
      </div>
    </div>
  );
}

function PhaseLoadingBlock({ state, hint }) {
  if (state === 'failed') {
    return (
      <div className="flex items-center gap-2 text-[11px] py-2" style={{ color: 'var(--rl-critical)' }}>
        <AlertTriangle size={12} /> 실패 · 재시도 필요
      </div>
    );
  }
  if (state === 'running') {
    return (
      <div className="flex items-center gap-2 text-[11px] py-2" style={{ color: 'var(--rl-primary)' }}>
        <Loader2 size={12} className="animate-spin" /> {hint}
      </div>
    );
  }
  // pending
  return (
    <div className="flex items-center gap-2 text-[11px] py-2" style={{ color: 'var(--rl-ink-3)' }}>
      <Circle size={12} /> 대기 중 · 이전 phase 완료 후 시작
    </div>
  );
}

/* ----- Workspace mock 데이터 derivation ----- */
function derivePatientHPO(patient) {
  // 환자 주호소 키워드에서 대표 HPO 추출 (mock)
  const text = (patient.complaint || '').toLowerCase();
  const all = [];
  if (/기침|cough/i.test(text))                all.push({ code: 'HP:0012735', label: '기침' });
  if (/호흡곤란|dyspnea|sob/i.test(text))      all.push({ code: 'HP:0002094', label: '호흡곤란' });
  if (/발열|fever/i.test(text))                all.push({ code: 'HP:0001945', label: '발열' });
  if (/객혈|hemoptysis/i.test(text))           all.push({ code: 'HP:0002105', label: '객혈' });
  if (/체중감소|weight loss/i.test(text))      all.push({ code: 'HP:0001824', label: '체중감소' });
  if (/야간|night sweat/i.test(text))          all.push({ code: 'HP:0002086', label: '야간 발한' });
  if (/기흉|pneumothorax/i.test(text))         all.push({ code: 'HP:0002107', label: '기흉' });
  if (/가래|sputum/i.test(text))               all.push({ code: 'HP:0031246', label: '가래 동반' });
  if (/흉통|chest pain/i.test(text))           all.push({ code: 'HP:0033712', label: '흉통' });
  if (/부종|edema/i.test(text))                all.push({ code: 'HP:0000969', label: '부종' });
  if (all.length === 0) all.push({ code: 'HP:0002094', label: '호흡기 증상' });
  return all;
}

function derivePatientLabs(patient) {
  // 시나리오별로 약간씩 다른 mock lab (top dx hint 활용)
  const dx = (patient.preview?.[0]?.name || '').toLowerCase();
  if (/pneumonia|폐렴/.test(dx)) {
    return [
      { name: 'WBC',  value: 18.5, unit: '×10³/μL', flag: 'H' },
      { name: 'CRP',  value: 150,  unit: 'mg/L',    flag: 'H' },
      { name: 'PCT',  value: 3.2,  unit: 'ng/mL',   flag: 'H' },
      { name: 'PaO₂', value: 58,   unit: 'mmHg',    flag: 'L' },
    ];
  }
  if (/ipf|폐섬유증|fibrosis/.test(dx)) {
    return [
      { name: 'KL-6', value: 1450, unit: 'U/mL', flag: 'H' },
      { name: 'SP-D', value: 215,  unit: 'ng/mL', flag: 'H' },
      { name: 'LDH',  value: 285,  unit: 'U/L',   flag: 'H' },
      { name: 'PaO₂', value: 71,   unit: 'mmHg',  flag: 'L' },
    ];
  }
  if (/lam|림프관/.test(dx)) {
    return [
      { name: 'VEGF-D', value: 1200, unit: 'pg/mL', flag: 'H' },
      { name: 'WBC',    value: 7.2,  unit: '×10³/μL' },
      { name: 'CRP',    value: 1.8,  unit: 'mg/L' },
    ];
  }
  if (/chf|heart failure|심부전/.test(dx)) {
    return [
      { name: 'BNP',  value: 2840, unit: 'pg/mL', flag: 'H' },
      { name: 'TnI',  value: 0.08, unit: 'ng/mL', flag: 'H' },
      { name: 'Cr',   value: 1.6,  unit: 'mg/dL', flag: 'H' },
    ];
  }
  // default
  return [
    { name: 'WBC', value: 9.2, unit: '×10³/μL' },
    { name: 'CRP', value: 12,  unit: 'mg/L', flag: 'H' },
    { name: 'Hb',  value: 13.5, unit: 'g/dL' },
  ];
}

function deriveChexpertLabels(patient) {
  // CXR 14 label score (mock)
  const dx = (patient.preview?.[0]?.name || '').toLowerCase();
  const base = {
    'No Finding': 0.05, 'Cardiomegaly': 0.08, 'Lung Opacity': 0.12, 'Lung Lesion': 0.06,
    'Edema': 0.04, 'Consolidation': 0.05, 'Pneumonia': 0.08, 'Atelectasis': 0.10,
    'Pneumothorax': 0.03, 'Pleural Effusion': 0.06, 'Pleural Other': 0.04,
    'Fracture': 0.02, 'Support Devices': 0.05, 'Enlarged Cardiomediastinum': 0.07,
  };
  if (/pneumonia|폐렴/.test(dx)) {
    base['Pneumonia'] = 0.92; base['Consolidation'] = 0.88; base['Lung Opacity'] = 0.85;
  } else if (/ipf|폐섬유증/.test(dx)) {
    base['Lung Opacity'] = 0.81;
  } else if (/lam|림프관/.test(dx)) {
    base['Pneumothorax'] = 0.78; base['Enlarged Cardiomediastinum'] = 0.61;
  } else if (/chf|heart failure/.test(dx)) {
    base['Cardiomegaly'] = 0.86; base['Pleural Effusion'] = 0.72; base['Edema'] = 0.68;
  } else if (/sarcoid/.test(dx)) {
    base['Lung Opacity'] = 0.74; base['Enlarged Cardiomediastinum'] = 0.62;
  }
  return Object.entries(base)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score);
}

/* ----------- TAB · REPORT (PDF mock 미리보기 + 새 창 전체화면) ----------- */
function ChartReport({ patient, finalReport = null, reportState = 'idle', phase3 = null, phase5 = null }) {
  const isReady = reportState === 'ready';
  const isGenerating = reportState === 'generating';

  // 전체화면 보기 — 의사 소견서 양식 새 창 (PDF 인쇄 가능)
  function handleFullscreen() {
    if (!isReady) return;
    if (finalReport?.diagnosis_json) { openClinicalReport(patient, finalReport, { phase3, phase5 }); return; }
    const md = finalReport?.markdown_report || finalReport?.full_report_md;
    if (md) { openMarkdownPopup(patient, md, finalReport); return; }
    openReportPopup(patient);
  }

  return (
    <div className="h-full fade-in">
      <Panel
        title="진단 리포트 · Preview"
        mono={
          isGenerating ? 'Report viewer · 생성중'
          : isReady    ? 'Report viewer · 준비됨'
                       : 'Report viewer · 미생성'
        }
        fill
        right={
          <button
            onClick={handleFullscreen}
            disabled={!isReady}
            className="text-[11px] font-medium flex items-center gap-1 hover:underline disabled:cursor-not-allowed disabled:no-underline"
            style={{
              color: isReady ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
              opacity: isReady ? 1 : 0.55,
            }}
            title={isReady ? '의사 소견서 양식으로 보기 · PDF 저장/인쇄 가능' : '리포트 생성 후 활성화됩니다'}
          >
            소견서 보기 · PDF <ArrowUpRight size={11} />
          </button>
        }
      >
        <div
          className="h-full"
          style={{ overflow: 'auto', background: 'var(--rl-bg-3)', padding: 16, minHeight: 0 }}
        >
          {isGenerating ? (
            <ReportPlaceholder
              icon={<Loader2 size={20} className="animate-spin" />}
              title="리포트 생성중"
              hint="RAG · 유사 케이스 retrieve + Bedrock Sonnet 합성"
              tone="info"
            />
          ) : !isReady ? (
            <ReportPlaceholder
              icon={<FileText size={20} />}
              title="리포트 미생성"
              hint="진단 워크스페이스에서 분석을 시작하면 RAG 리포트가 자동 생성됩니다."
              tone="muted"
            />
          ) : finalReport ? (
            <BackendReportView patient={patient} finalReport={finalReport} phase3={phase3} phase5={phase5} />
          ) : (
            <>
              <ReportPage patient={patient} pageNo={1} totalPages={2} />
              <ReportPage patient={patient} pageNo={2} totalPages={2} />
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

/* 리포트 미생성 / 생성중 placeholder */
function ReportPlaceholder({ icon, title, hint, tone = 'muted' }) {
  const accent = tone === 'info' ? 'var(--rl-primary)' : 'var(--rl-ink-3)';
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', minHeight: 320, padding: 24, textAlign: 'center',
        background: 'white', border: '1px dashed var(--rl-border)',
      }}
    >
      <div style={{ color: accent, marginBottom: 12 }}>{icon}</div>
      <div className="font-serif" style={{ fontSize: 16, color: 'var(--rl-ink)', marginBottom: 6 }}>{title}</div>
      <div className="text-[11px]" style={{ color: 'var(--rl-ink-3)', maxWidth: 360, lineHeight: 1.6 }}>{hint}</div>
    </div>
  );
}

/* backend RAG 결과 (markdown_report + citations) inline render */
/* 리포트 탭 본문 — diagnosis_json(구조화 진단 결과)을 의사 소견서 양식으로 렌더.
   RAG 의 markdown_report 는 HTML 덩어리라 그대로 쓰지 않고, clinical_notes /
   recommendation / confidence_metrics 를 섹션으로 문서화한다. */
function BackendReportView({ patient, finalReport, phase3 = null, phase5 = null }) {
  const sex = patient.sex === 'M' ? '남' : '여';
  let dj = finalReport.diagnosis_json;
  if (typeof dj === 'string') { try { dj = JSON.parse(dj); } catch (_) { dj = null; } }
  const cn  = (dj && dj.clinical_notes)     || {};
  const rec = (dj && dj.recommendation)     || {};
  const cm  = (dj && dj.confidence_metrics) || {};
  const apis = finalReport.rag_apis_used || [];
  const hasStructured = Object.keys(cn).length > 0 || Object.keys(rec).length > 0;

  // ── 흉부 X-ray — 원본은 무조건, heatmap 은 분석 상태에 따라 ──
  const studies = normalizeCxrStudies(patient);
  const study0  = studies[0] || null;
  const cxrAnalyzed = patient.status === 'ready';
  const cxrPos  = deriveChexpertLabels(patient).filter(l => l.score >= 0.5);
  const topCxr  = cxrPos[0] || null;
  const heatCap = !cxrAnalyzed ? '—' : !topCxr ? '이상 없음' : `${topCxr.name} · ${Math.round(topCxr.score * 100)}%`;

  // ── ranking / listing ──
  const p3list = (phase3 && Array.isArray(phase3.top_candidates)) ? phase3.top_candidates : [];
  const p5thr  = (phase5 && phase5.listing_criteria && phase5.listing_criteria.threshold_lr) || 5;
  // 백엔드 Phase 5 우선, 미도착 시 Overview 와 동일하게 환자 preview rare 후보로 폴백
  const p5rows = phase5ListingRows(patient, phase5);

  const H3 = ({ no, children }) => (
    <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--rl-primary)', margin: '0 0 5px',
                 paddingBottom: 3, borderBottom: '1px solid var(--rl-border)' }}>
      <span className="font-mono" style={{ marginRight: 5 }}>{no}</span>{children}
    </h3>
  );
  const Sec = ({ no, title, text }) => !text ? null : (
    <section style={{ marginTop: 14, breakInside: 'avoid' }}>
      <H3 no={no}>{title}</H3>
      <p style={{ fontSize: 12, lineHeight: 1.75, color: 'var(--rl-ink-2)', margin: 0, whiteSpace: 'pre-wrap' }}>
        {renderLinkedText(text)}
      </p>
    </section>
  );
  const RecBlock = ({ label, items }) => (!Array.isArray(items) || !items.length) ? null : (
    <div style={{ breakInside: 'avoid' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--rl-primary-dark)',
                    background: 'var(--rl-bg-3)', padding: '3px 8px', borderLeft: '3px solid var(--rl-primary)' }}>
        {label}
      </div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {items.map((x, i) => (
          <li key={i} style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--rl-ink-2)' }}>{renderLinkedText(x)}</li>
        ))}
      </ul>
    </div>
  );
  // ranking/listing 표
  const RankTable = ({ rows }) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, marginTop: 5 }}>
      <thead><tr>{rows.head.map((h, i) => (
        <th key={i} style={{ textAlign: h.r ? 'right' : 'left', padding: '5px 8px', background: 'var(--rl-bg-3)',
              borderBottom: '1px solid var(--rl-border)', fontSize: 9, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: 'var(--rl-ink-3)' }} className="font-mono">{h.t}</th>
      ))}</tr></thead>
      <tbody>{rows.body.map((r, i) => (
        <tr key={i}>{r.map((c, j) => (
          <td key={j} className={c.mono ? 'font-mono' : undefined}
              style={{ textAlign: c.r ? 'right' : 'left', padding: '5px 8px',
                       borderBottom: '1px solid var(--rl-border)', color: 'var(--rl-ink-2)' }}>{c.v}</td>
        ))}</tr>
      ))}</tbody>
    </table>
  );
  const Empty = ({ children }) => (
    <div style={{ fontSize: 11.5, color: 'var(--rl-ink-3)', padding: 8, background: 'var(--rl-bg-2)', borderRadius: 3, marginTop: 5 }}>
      {children}
    </div>
  );

  const score = Number(cm.overall_confidence_score);
  const hasScore = Number.isFinite(score);
  const sLabel = !hasScore ? '—' : score >= 0.75 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : 'LOW';
  const sColor = !hasScore ? 'var(--rl-ink-3)' : score >= 0.75 ? 'var(--rl-teal)' : score >= 0.5 ? 'var(--rl-amber)' : 'var(--rl-critical)';
  const ds = cm.data_sufficiency || {};
  const DsRow = ({ k, v }) => !v ? null : (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', borderBottom: '1px dotted var(--rl-border)' }}>
      <span style={{ color: 'var(--rl-ink-3)' }}>{k}</span>
      <span className="font-mono" style={{ fontSize: 10 }}>{v}</span>
    </div>
  );

  // 참고 출처 — 논문 reference 양식
  const REF_ORG = {
    PubMed: 'U.S. National Library of Medicine',
    'ClinicalTrials.gov': 'U.S. National Institutes of Health',
    Orphanet: 'INSERM · Orphanet',
  };
  const collected = collectEvidence(dj, finalReport && (finalReport.markdown_report || finalReport.full_report_md));

  const cxrBox = { aspectRatio: '1 / 1', background: '#0A1628', position: 'relative',
                   overflow: 'hidden', border: '1px solid var(--rl-border)' };
  const cxrCap = { fontFamily: 'IBM Plex Mono, monospace', fontSize: 9, textTransform: 'uppercase',
                   letterSpacing: '0.1em', color: 'var(--rl-ink-3)', marginBottom: 3 };

  return (
    <div style={{ background: 'white', padding: 32, maxWidth: 840, margin: '0 auto', border: '1px solid var(--rl-border)' }}>
      {/* 문서 헤더 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', paddingBottom: 8, borderBottom: '3px solid var(--rl-primary)', marginBottom: 14 }}>
        <div>
          <div className="font-mono" style={{ fontSize: 9, letterSpacing: '0.16em', color: 'var(--rl-primary)', textTransform: 'uppercase' }}>
            Soo-Pul · SooNet-Pulmonary Clinical Decision Support
          </div>
          <div className="font-serif" style={{ fontSize: 19, color: 'var(--rl-primary-dark)', marginTop: 2 }}>AI 기반 임상소견서</div>
        </div>
        <div className="font-mono ml-auto" style={{ fontSize: 9, color: 'var(--rl-ink-3)', textAlign: 'right', lineHeight: 1.7 }}>
          발급 {(finalReport.generated_at || '').toString().slice(0, 19).replace('T', ' ')}<br />
          {finalReport.llm_model || ''}
        </div>
      </div>

      {/* 환자 정보 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', border: '1px solid var(--rl-border)', marginBottom: 4 }}>
        {[
          ['환자명', patient.name],
          ['등록번호 (MRN)', patient.mrn],
          ['성별 / 나이', `${sex} / ${patient.age}세`],
          ['주호소', patient.complaint || '—'],
        ].map(([k, v], i) => (
          <div key={i} style={{ padding: '8px 10px', borderRight: i < 3 ? '1px solid var(--rl-border)' : 'none' }}>
            <div className="font-mono" style={{ fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--rl-ink-3)', marginBottom: 3 }}>{k}</div>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Ⅰ. 흉부 X-ray — 원본 무조건 + heatmap(최상위 label / 이상없음 / 분석없음) */}
      <section style={{ marginTop: 14, breakInside: 'avoid' }}>
        <H3 no="Ⅰ.">흉부 X-ray 영상 소견</H3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
          <div>
            <div style={cxrCap}>원본 · Original</div>
            <div style={cxrBox}><CxrViewer study={study0} heatmap={false} /></div>
          </div>
          <div>
            <div style={cxrCap}>Heatmap · {heatCap}</div>
            <div style={cxrBox}>
              {!cxrAnalyzed ? <CxrHeatmapState kind="none" />
               : !topCxr   ? <CxrHeatmapState kind="normal" />
               : <CxrViewer study={study0} heatmap={true}
                   focalRegions={LABEL_FOCAL_REGIONS[topCxr.name] || null} labelName={topCxr.name} />}
            </div>
          </div>
        </div>
      </section>

      {hasStructured ? (
        <>
          <Sec no="Ⅱ." title="임상 요약" text={cn.summary} />
          <Sec no="Ⅲ." title="주진단 추론" text={cn.top1_reasoning} />

          {/* Ⅳ. 감별진단 순위 (Phase 3·4) */}
          <section style={{ marginTop: 14, breakInside: 'avoid' }}>
            <H3 no="Ⅳ.">감별진단 순위 · Phase 3·4 다중모달 통합 스코어</H3>
            {p3list.length > 0 ? (
              <RankTable rows={{
                head: [{ t: '순위' }, { t: '질환' }, { t: '통합 스코어', r: true }],
                body: p3list.slice(0, 10).map((c, i) => {
                  const v = Number(c.lr_score);
                  return [
                    { v: `#${i + 1}`, mono: true },
                    { v: c.name_en
                        ? <span>{c.name}<span style={{ display: 'block', fontSize: 10, color: 'var(--rl-ink-3)', fontStyle: 'italic' }}>{c.name_en}</span></span>
                        : c.name },
                    { v: Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—', r: true, mono: true },
                  ];
                }),
              }} />
            ) : <Empty>감별진단 순위 데이터 없음</Empty>}
          </section>

          {/* Ⅴ. 희귀질환 listing (Phase 5) */}
          <section style={{ marginTop: 14, breakInside: 'avoid' }}>
            <H3 no="Ⅴ.">희귀질환 listing · Phase 5 LIRICAL Likelihood Ratio</H3>
            {p5rows.length > 0 ? (
              <RankTable rows={{
                head: [{ t: '순위' }, { t: '희귀질환' }, { t: 'LR', r: true }, { t: 'ORPHA' }],
                body: p5rows.map((d, i) => [
                  { v: `#${i + 1}`, mono: true },
                  { v: d.name },
                  { v: d.value, r: true, mono: true },
                  { v: d.orpha, mono: true },
                ]),
              }} />
            ) : <Empty>LIRICAL Likelihood Ratio &gt; {p5thr} 임계를 만족하는 희귀질환 없음</Empty>}
          </section>

          <Sec no="Ⅵ." title="감별진단" text={cn.differential_note} />
          <Sec no="Ⅶ." title="유사 증례 비교" text={cn.case_comparison} />
          <Sec no="Ⅷ." title="진단 근거 (RAG)" text={cn.rag_evidence} />
          <Sec no="Ⅸ." title="역학 정보" text={cn.epidemiology_note} />

          {Object.keys(rec).length > 0 && (
            <section style={{ marginTop: 14, breakInside: 'avoid' }}>
              <H3 no="Ⅹ.">권고 사항</H3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 14px' }}>
                <RecBlock label="즉시 시행 검사" items={rec.immediate_workup} />
                <RecBlock label="추가 검사" items={rec.additional_lab} />
                <RecBlock label="유전자 검사" items={rec.genetic_test} />
                <RecBlock label="전문의 의뢰" items={rec.specialist_referral} />
                <RecBlock label="치료 가이드라인" items={rec.treatment_guideline} />
                <RecBlock label="임상시험 정보" items={rec.clinical_trial_info} />
              </div>
            </section>
          )}

          {Object.keys(cm).length > 0 && (
            <section style={{ marginTop: 14, breakInside: 'avoid' }}>
              <H3 no="Ⅺ.">신뢰도 평가</H3>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ flexShrink: 0, textAlign: 'center', border: '1px solid var(--rl-border)', padding: '8px 14px' }}>
                  <div className="font-serif" style={{ fontSize: 26, lineHeight: 1, color: sColor }}>
                    {hasScore ? Math.round(score * 100) : '—'}<span style={{ fontSize: 13 }}>{hasScore ? '%' : ''}</span>
                  </div>
                  <div className="font-mono" style={{ fontSize: 9, letterSpacing: '0.12em', marginTop: 3, color: sColor }}>{sLabel}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <DsRow k="유전체 근거" v={ds.genomic_evidence} />
                  <DsRow k="임상시험 가용성" v={ds.trial_availability} />
                  <DsRow k="유사 증례 일치도" v={ds.clinical_case_match} />
                  {cm.rationale && (
                    <p style={{ fontSize: 11, lineHeight: 1.65, color: 'var(--rl-ink-2)', margin: '6px 0 0' }}>
                      {renderLinkedText(cm.rationale)}
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}
        </>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--rl-ink-3)', padding: '16px 0' }}>
          구조화된 진단 데이터가 없습니다. "소견서 보기 · PDF"로 원문을 확인하세요.
        </div>
      )}

      {/* 참고 출처 — 논문 reference 양식. 식별자가 없어도 섹션은 항상 표시. */}
      <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--rl-border)', breakInside: 'avoid' }}>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)', marginBottom: 8 }}>
          참고 출처 · References ({collected.length})
        </div>
        {collected.length > 0 ? (
          <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {collected.map((tok, i) => {
              const url = evidenceUrl(tok);
              const ty = evidenceType(tok);
              const org = REF_ORG[ty] || '';
              return (
                <li key={i} style={{ display: 'flex', gap: 6, fontSize: 10.5, lineHeight: 1.65, color: 'var(--rl-ink-2)', margin: '4px 0' }}>
                  <span className="font-mono" style={{ color: 'var(--rl-ink-3)', flexShrink: 0, minWidth: 20 }}>{i + 1}.</span>
                  <span style={{ flex: 1 }}>
                    {ty}{org ? ` (${org})` : ''}. {tok}.{' '}
                    {url && <>Available from: <a href={url} target="_blank" rel="noopener noreferrer"
                      style={{ color: 'var(--rl-primary)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{url}</a></>}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--rl-ink-3)', lineHeight: 1.6 }}>
            본 리포트는 외부 의학 데이터베이스
            {apis.length ? ` (${apis.join(' · ')})` : ' (PubMed · Monarch · ClinicalTrials.gov · PubCaseFinder)'}
            를 조회해 작성되었습니다. 개별 인용 식별자(PMID·NCT·ORPHA)는 본문에 표기됩니다.
          </div>
        )}
      </div>
      {apis.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {apis.map(a => (
            <span key={a} className="font-mono text-[10px] chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>{a}</span>
          ))}
        </div>
      )}
      <div style={{ marginTop: 18, paddingTop: 10, borderTop: '2px solid var(--rl-primary)' }}>
        <div style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)', padding: '8px 10px', fontSize: 10.5, color: '#92400E', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--rl-amber)' }}>⚠ AI 보조 진단 — 본 소견서는 진단 보조 목적입니다.</strong><br />
          {cn.disclaimer || '최종 진단 및 치료 결정은 반드시 주치의의 임상적 판단과 추가 검사 결과를 종합하여 확정합니다.'} [EU AI Act Art. 22]
        </div>
      </div>
    </div>
  );
}

function ReportPage({ patient, pageNo, totalPages }) {
  return (
    <div
      className="bg-white mx-auto mb-3"
      style={{
        aspectRatio: '210 / 297',
        maxWidth: 540,
        boxShadow: '0 4px 16px rgba(10,22,40,0.12)',
        border: '1px solid var(--rl-border-soft)',
        padding: 28,
        display: 'flex',
        flexDirection: 'column',
        fontSize: 11,
        color: 'var(--rl-ink)',
      }}
    >
      {/* Letterhead */}
      <div className="flex items-baseline gap-3 pb-3" style={{ borderBottom: '2px solid var(--rl-primary)' }}>
        <div className="font-serif text-base leading-none" style={{ color: 'var(--rl-primary-dark)' }}>
          성균관대학교병원
        </div>
        <div className="text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>호흡기내과 · Pulmonary Division</div>
        <div className="ml-auto font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          AI-Assisted Diagnostic Report
        </div>
      </div>

      <div className="flex justify-between items-baseline mt-3 mb-3 font-mono text-[9px]" style={{ color: 'var(--rl-ink-3)' }}>
        <div>Report ID · RPT-2026-0423-{patient.mrn.replace('-', '')}</div>
        <div>Page {pageNo} / {totalPages} · 발행 2026-04-23 09:14 KST</div>
      </div>

      {pageNo === 1 ? (
        <ReportPage1 patient={patient} />
      ) : (
        <ReportPage2 patient={patient} />
      )}

      {/* Footer disclaimer · 모든 페이지 공통 */}
      <div className="mt-auto pt-3" style={{ borderTop: '1px solid var(--rl-border-soft)' }}>
        <div className="font-mono text-[8px] uppercase tracking-widest" style={{ color: 'var(--rl-amber)' }}>
          ⚠ AI-Assisted · Final diagnosis requires physician review
        </div>
        <div className="text-[9px] mt-1" style={{ color: 'var(--rl-ink-3)' }}>
          본 리포트의 AI 분석 결과는 진단 보조용이며 최종 진단 및 치료 결정은 주치의의 임상적 판단에 따릅니다. [EU AI Act Art. 22]
        </div>
      </div>
    </div>
  );
}

function ReportPage1({ patient }) {
  const top = (patient.preview || [])[0];
  return (
    <>
      {/* Patient block */}
      <div className="grid grid-cols-3 gap-3 mb-3 p-2.5" style={{ background: 'var(--rl-bg-2)', border: '1px solid var(--rl-border-soft)' }}>
        <ReportField label="환자명" value={patient.name} />
        <ReportField label="MRN" value={patient.mrn} mono />
        <ReportField label="나이 · 성별" value={`${patient.sex === 'M' ? '남' : '여'} · ${patient.age}세`} />
        <ReportField label="방문 일자" value={patient.visitDate || '2026-04-23'} mono />
        <ReportField label="방문 유형" value={patient.visit} />
        <ReportField label="알러지" value={patient.allergy || '없음'} />
      </div>

      {/* Chief complaint */}
      <ReportSection title="1. 주호소 · Chief Complaint">
        <div className="text-[11px] leading-relaxed t-bilingual"><BiText>{patient.complaint}</BiText></div>
      </ReportSection>

      {/* AI Differential */}
      <ReportSection title="2. AI 감별진단 · Top 3 Differential (DenseNet-121 + HPO-LR)">
        <table className="w-full text-[10px]" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--rl-border)' }}>
              <th className="text-left py-1 font-mono text-[9px] uppercase" style={{ color: 'var(--rl-ink-3)' }}>#</th>
              <th className="text-left py-1 font-mono text-[9px] uppercase" style={{ color: 'var(--rl-ink-3)' }}>진단명</th>
              <th className="text-right py-1 font-mono text-[9px] uppercase" style={{ color: 'var(--rl-ink-3)' }}>확률</th>
              <th className="text-left py-1 font-mono text-[9px] uppercase pl-2" style={{ color: 'var(--rl-ink-3)' }}>플래그</th>
            </tr>
          </thead>
          <tbody>
            {(patient.preview || []).slice(0, 3).map((dx, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
                <td className="py-1.5 font-mono">{i + 1}</td>
                <td className="py-1.5">
                  <BiText>{dx.name}</BiText>
                  {dx.orpha && <span className="font-mono ml-1.5 text-[9px]" style={{ color: 'var(--rl-ink-3)' }}>{dx.orpha}</span>}
                </td>
                <td className="py-1.5 text-right font-serif">{(dx.prob * 100).toFixed(0)}%</td>
                <td className="py-1.5 pl-2">
                  {dx.dontMiss && <span className="font-mono text-[9px]" style={{ color: 'var(--rl-amber)' }}>Don't miss</span>}
                  {dx.dontMiss && dx.rare && ' · '}
                  {dx.rare && <span className="font-mono text-[9px]" style={{ color: 'var(--rl-rare)' }}>희귀</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportSection>

      {/* Recommendation */}
      <ReportSection title="3. 권고 · Recommendation">
        <ul className="text-[10px] leading-relaxed pl-4" style={{ listStyle: 'disc' }}>
          {top && top.dontMiss && <li><b>{top.name}</b> 의심 — HRCT 및 폐기능검사(PFT) 우선 권고</li>}
          {top && top.rare && <li>희귀질환 가능성 → 호흡기내과 + 영상의학과 multidisciplinary discussion(MDT) 권고</li>}
          <li>주치의 검토 후 진단 확정 및 치료 방향 결정 필요</li>
          <li>관련 lab 추가 권고: BAL fluid 분석, 자가항체 패널 (ANA, RF, Anti-CCP)</li>
        </ul>
      </ReportSection>
    </>
  );
}

function ReportPage2({ patient }) {
  const reportStudies = normalizeCxrStudies(patient);
  const reportLatest = reportStudies[0] || null;
  return (
    <>
      <ReportSection title="4. CXR · Frontal + Heatmap">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <div className="font-mono text-[8px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-ink-3)' }}>원본 · Original</div>
            <div style={{ background: '#0A1628', aspectRatio: '1 / 1', overflow: 'hidden', border: '1px solid var(--rl-border)', position: 'relative' }}>
              <CxrViewer study={reportLatest} heatmap={false} />
            </div>
          </div>
          <div>
            <div className="font-mono text-[8px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-amber)' }}>Heatmap</div>
            <div style={{ background: '#0A1628', aspectRatio: '1 / 1', overflow: 'hidden', border: '1px solid rgba(180,83,9,0.4)', position: 'relative' }}>
              <CxrViewer study={reportLatest} heatmap={true} />
            </div>
          </div>
        </div>
        <div className="text-[9px]" style={{ color: 'var(--rl-ink-3)' }}>
          AI 모델: DenseNet-121 · 입력 448×448 · Heatmap 활성 영역: 양측 폐 하부 reticular pattern (HRCT 권고)
        </div>
      </ReportSection>

      <ReportSection title="5. 임상 소견 · Clinical Notes">
        <div className="text-[10px] leading-relaxed">
          본 환자는 <b>{patient.complaint}</b>로 내원한 {patient.age}세 {patient.sex === 'M' ? '남성' : '여성'}으로,
          AI 보조 분석 결과 상위 감별진단 중 <b>{(patient.preview || [{ name: '—' }])[0].name}</b>이 가장 확률 높게 제시되었습니다.
          단, AI 결과는 진단 보조이며 최종 진단은 주치의의 임상 판단과 추가 검사 결과를 종합하여 확정합니다.
        </div>
      </ReportSection>

      <ReportSection title="6. 의사 서명 · Physician Sign-off">
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest mb-2" style={{ color: 'var(--rl-ink-3)' }}>주치의</div>
            <div className="font-serif text-sm" style={{ borderBottom: '1px solid var(--rl-ink)', paddingBottom: 2 }}>
              정민수 과장
            </div>
            <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--rl-ink-3)' }}>호흡기내과 · 면허 #12345</div>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest mb-2" style={{ color: 'var(--rl-ink-3)' }}>전자 서명일</div>
            <div className="font-mono text-sm" style={{ borderBottom: '1px solid var(--rl-ink)', paddingBottom: 2 }}>
              2026-04-23 09:14 KST
            </div>
            <div className="font-mono text-[9px] mt-1" style={{ color: 'var(--rl-ink-3)' }}>HASH · SHA256:a4f9…7c2b</div>
          </div>
        </div>
      </ReportSection>
    </>
  );
}

function ReportField({ label, value, mono }) {
  return (
    <div>
      <div className="font-mono text-[8px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>{label}</div>
      <div className={`text-[11px] ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--rl-ink)' }}>
        {mono ? value : <BiText>{value}</BiText>}
      </div>
    </div>
  );
}

function ReportSection({ title, children }) {
  return (
    <div className="mb-3">
      <div className="font-mono text-[10px] uppercase tracking-widest mb-1.5" style={{ color: 'var(--rl-primary)' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/* PDF 전체화면 popup · 같은 리포트 콘텐츠를 새 창에 풀스크린으로 */
function openReportPopup(patient) {
  const w = window.open('', `rpt-${patient.mrn}`, 'width=900,height=1100,resizable=yes,scrollbars=yes');
  if (!w) {
    alert('팝업 차단을 해제해주세요.');
    return;
  }
  const sex = patient.sex === 'M' ? '남' : '여';
  const date = patient.visitDate || '2026-04-23';
  const top3 = (patient.preview || []).slice(0, 3);
  const top = top3[0] || { name: '—' };

  const dxRows = top3.map((dx, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${dx.name}${dx.orpha ? ` <span class="mono muted">${dx.orpha}</span>` : ''}</td>
      <td class="right serif">${(dx.prob * 100).toFixed(0)}%</td>
      <td>${dx.dontMiss ? '<span class="amber">Don\'t miss</span>' : ''}${dx.dontMiss && dx.rare ? ' · ' : ''}${dx.rare ? '<span class="rare">희귀</span>' : ''}</td>
    </tr>`).join('');

  const recs = [];
  if (top.dontMiss) recs.push(`<b>${top.name}</b> 의심 — HRCT 및 폐기능검사(PFT) 우선 권고`);
  if (top.rare) recs.push('희귀질환 가능성 → 호흡기내과 + 영상의학과 MDT 권고');
  recs.push('주치의 검토 후 진단 확정 및 치료 방향 결정 필요');
  recs.push('관련 lab 추가 권고: BAL fluid 분석, 자가항체 패널 (ANA, RF, Anti-CCP)');

  w.document.write(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>리포트 · ${patient.name} · ${patient.mrn}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html, body { margin: 0; padding: 0; }
  body { background: #F1F5F9; font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif; color: #0A1628; padding: 24px; -webkit-font-smoothing: antialiased; }
  .page {
    background: white; max-width: 794px; margin: 0 auto 16px;
    box-shadow: 0 4px 16px rgba(10,22,40,0.12);
    border: 1px solid #E2E8F0;
    padding: 48px;
    aspect-ratio: 210 / 297;
    display: flex; flex-direction: column;
    font-size: 12px;
  }
  .letterhead { display: flex; align-items: baseline; gap: 12px; padding-bottom: 8px; border-bottom: 2px solid #0C447C; }
  .letterhead .name { font-family: 'IBM Plex Serif', serif; font-size: 18px; color: #083158; }
  .letterhead .div { font-size: 11px; color: #64748B; }
  .letterhead .label { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; }
  .meta { display: flex; justify-content: space-between; margin: 12px 0; font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #64748B; }
  .patient { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 12px; background: #F8FAFC; border: 1px solid #E2E8F0; margin-bottom: 14px; }
  .patient .label { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; }
  .patient .val { font-size: 12px; }
  .section { margin-bottom: 14px; }
  .section .title { font-family: 'IBM Plex Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: #0C447C; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  table th { text-align: left; padding: 4px 0; border-bottom: 1px solid #CBD5E1; font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; color: #64748B; }
  table td { padding: 6px 0; border-bottom: 1px solid #E2E8F0; }
  table .right { text-align: right; }
  .serif { font-family: 'IBM Plex Serif', serif; }
  .mono { font-family: 'IBM Plex Mono', monospace; }
  .muted { color: #64748B; font-size: 10px; }
  .amber { color: #B45309; font-family: 'IBM Plex Mono', monospace; font-size: 10px; }
  .rare { color: #6B21A8; font-family: 'IBM Plex Mono', monospace; font-size: 10px; }
  ul { font-size: 11px; line-height: 1.6; padding-left: 18px; margin: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .img { background: #0A1628; aspect-ratio: 1 / 1; overflow: hidden; border: 1px solid #CBD5E1; }
  .img.heat { border-color: rgba(180,83,9,0.4); }
  .img-label { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 4px; color: #334155; }
  .img-label.heat { color: #B45309; }
  .signoff { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
  .signoff .label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; margin-bottom: 8px; }
  .signoff .line { border-bottom: 1px solid #0A1628; padding-bottom: 2px; }
  .signoff .name-sig { font-family: 'IBM Plex Serif', serif; font-size: 14px; }
  .signoff .date-sig { font-family: 'IBM Plex Mono', monospace; font-size: 14px; }
  .signoff .hash { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: #64748B; margin-top: 4px; }
  .footer { margin-top: auto; padding-top: 10px; border-top: 1px solid #E2E8F0; }
  .footer .warn { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #B45309; }
  .footer .disc { font-size: 10px; color: #64748B; margin-top: 3px; }
</style>
</head>
<body>
  <div class="page">
    <div class="letterhead">
      <div class="name">성균관대학교병원</div>
      <div class="div">호흡기내과 · Pulmonary Division</div>
      <div class="label">AI-Assisted Diagnostic Report</div>
    </div>
    <div class="meta">
      <span>Report ID · RPT-2026-0423-${patient.mrn.replace('-', '')}</span>
      <span>Page 1 / 2 · 발행 2026-04-23 09:14 KST</span>
    </div>
    <div class="patient">
      <div><div class="label">환자명</div><div class="val">${patient.name}</div></div>
      <div><div class="label">MRN</div><div class="val mono">${patient.mrn}</div></div>
      <div><div class="label">나이 · 성별</div><div class="val">${sex} · ${patient.age}세</div></div>
      <div><div class="label">방문 일자</div><div class="val mono">${date}</div></div>
      <div><div class="label">방문 유형</div><div class="val">${patient.visit}</div></div>
      <div><div class="label">알러지</div><div class="val">${patient.allergy || '없음'}</div></div>
    </div>
    <div class="section">
      <div class="title">1. 주호소 · Chief Complaint</div>
      <div>${patient.complaint}</div>
    </div>
    <div class="section">
      <div class="title">2. AI 감별진단 · Top 3 Differential (DenseNet-121 + HPO-LR)</div>
      <table>
        <thead><tr><th>#</th><th>진단명</th><th class="right">확률</th><th>플래그</th></tr></thead>
        <tbody>${dxRows}</tbody>
      </table>
    </div>
    <div class="section">
      <div class="title">3. 권고 · Recommendation</div>
      <ul>${recs.map(r => `<li>${r}</li>`).join('')}</ul>
    </div>
    <div class="footer">
      <div class="warn">⚠ AI-Assisted · Final diagnosis requires physician review</div>
      <div class="disc">본 리포트의 AI 분석 결과는 진단 보조용이며 최종 진단 및 치료 결정은 주치의의 임상적 판단에 따릅니다. [EU AI Act Art. 22]</div>
    </div>
  </div>

  <div class="page">
    <div class="letterhead">
      <div class="name">성균관대학교병원</div>
      <div class="div">호흡기내과 · Pulmonary Division</div>
      <div class="label">AI-Assisted Diagnostic Report</div>
    </div>
    <div class="meta">
      <span>Report ID · RPT-2026-0423-${patient.mrn.replace('-', '')}</span>
      <span>Page 2 / 2 · 발행 2026-04-23 09:14 KST</span>
    </div>
    <div class="section">
      <div class="title">4. CXR · Frontal + Heatmap</div>
      <div class="grid2">
        <div>
          <div class="img-label">원본 · Original</div>
          <div class="img">${buildCxrSvg({ heatmap: false })}</div>
        </div>
        <div>
          <div class="img-label heat">Heatmap</div>
          <div class="img heat">${buildCxrSvg({ heatmap: true })}</div>
        </div>
      </div>
      <div class="muted" style="margin-top:6px;">AI 모델: DenseNet-121 · 입력 448×448 · Heatmap 활성 영역: 양측 폐 하부 reticular pattern (HRCT 권고)</div>
    </div>
    <div class="section">
      <div class="title">5. 임상 소견 · Clinical Notes</div>
      <div>본 환자는 <b>${patient.complaint}</b>로 내원한 ${patient.age}세 ${sex === '남' ? '남성' : '여성'}으로, AI 보조 분석 결과 상위 감별진단 중 <b>${top.name}</b>이 가장 확률 높게 제시되었습니다. 단, AI 결과는 진단 보조이며 최종 진단은 주치의의 임상 판단과 추가 검사 결과를 종합하여 확정합니다.</div>
    </div>
    <div class="section">
      <div class="title">6. 의사 서명 · Physician Sign-off</div>
      <div class="signoff">
        <div>
          <div class="label">주치의</div>
          <div class="line name-sig">정민수 과장</div>
          <div class="hash">호흡기내과 · 면허 #12345</div>
        </div>
        <div>
          <div class="label">전자 서명일</div>
          <div class="line date-sig">2026-04-23 09:14 KST</div>
          <div class="hash">HASH · SHA256:a4f9…7c2b</div>
        </div>
      </div>
    </div>
    <div class="footer">
      <div class="warn">⚠ AI-Assisted · Final diagnosis requires physician review</div>
      <div class="disc">본 리포트의 AI 분석 결과는 진단 보조용이며 최종 진단 및 치료 결정은 주치의의 임상적 판단에 따릅니다. [EU AI Act Art. 22]</div>
    </div>
  </div>
</body>
</html>`);
  w.document.close();
}

/* ----------- TAB · HISTORY (과거 방문 + 클릭 새 창 상세) ----------- */
const DEFAULT_HISTORY = [
  {
    date: '2026-04-09', visit: '재진',
    complaint: '기침 악화 · 운동 시 호흡곤란 (mMRC 2)',
    dx: '특발성 폐섬유증 (IPF) · stable',
    tx: 'Pirfenidone 801mg tid 유지 · NAC 600mg bid',
    physician: '정민수 과장',
    vitals: 'BP 128/76 · HR 84 · RR 18 · SpO₂ 95% (RA)',
    notes: 'HRCT 변화 없음. 6분 보행거리 412m (+8m vs 직전). FVC 2.84L (68% predicted, +1%). 약물 부작용 호소 없음.',
  },
  {
    date: '2026-03-12', visit: '재진',
    complaint: 'FU · 피로감 호소',
    dx: 'IPF · 안정적 · 약물 적응 양호',
    tx: 'Pirfenidone 유지 · NAC 추가 처방',
    physician: '정민수 과장',
    vitals: 'BP 132/80 · HR 88 · RR 18 · SpO₂ 94% (RA)',
    notes: 'FVC 2.81L (67% pred). 식욕부진은 자연 호전. NAC 600mg bid 추가하여 산화 스트레스 감소 시도.',
  },
  {
    date: '2026-02-05', visit: '재진',
    complaint: '저용량 적응 · 1개월 평가',
    dx: 'IPF · 약물 적응 양호',
    tx: 'Pirfenidone 267mg tid → 534mg tid 증량',
    physician: '정민수 과장',
    vitals: 'BP 130/78 · HR 82 · RR 18 · SpO₂ 95% (RA)',
    notes: '경미한 오심 외 특이사항 없음. AST/ALT 정상 범위. 권고대로 단계적 증량 시작.',
  },
  {
    date: '2026-01-15', visit: '초진',
    complaint: '호흡곤란 6개월 · 마른기침 · 체중감소 4kg',
    dx: 'IPF (UIP pattern HRCT 확진)',
    tx: 'Pirfenidone 267mg tid 시작 · 폐 재활 의뢰',
    physician: '정민수 과장',
    vitals: 'BP 134/82 · HR 90 · RR 20 · SpO₂ 93% (RA)',
    notes: 'HRCT: 양측 하부 honeycombing + traction bronchiectasis · UIP pattern definite. PFT: restrictive (FVC 2.78L, 66% pred · DLCO 52% pred). MDT 결과 IPF 확진. Anti-fibrotic 시작.',
  },
  {
    date: '2025-12-08', visit: '의뢰',
    complaint: 'CXR 이상 → 호흡기내과 의뢰 (1차의원)',
    dx: 'ILD 의심 (HRCT 권고)',
    tx: 'HRCT 예약 · 폐기능검사 처방',
    physician: '김재현 (의뢰)',
    vitals: 'BP 128/76 · HR 86 · RR 18 · SpO₂ 95% (RA)',
    notes: '직장 건강검진 CXR에서 양측 하부 reticular opacity 발견되어 호흡기내과 의뢰됨. HRCT + PFT 예약.',
  },
];

function ChartHistory({ patient }) {
  const history = patient.history || DEFAULT_HISTORY;
  return (
    <div className="h-full fade-in">
      <Panel
        title="진단 히스토리"
        mono={`${history.length} visits · 클릭 → 상세`}
        fill
      >
        {/* Header row */}
        <div
          className="grid items-baseline font-mono text-[9px] uppercase tracking-widest pb-1.5 px-2"
          style={{
            gridTemplateColumns: HISTORY_GRID,
            columnGap: 8,
            color: 'var(--rl-ink-4)',
            borderBottom: '1px solid var(--rl-border-soft)',
          }}
        >
          <div>방문일</div>
          <div>유형</div>
          <div>주호소</div>
          <div>진단</div>
          <div>처방</div>
          <div></div>
        </div>
        <div>
          {history.map((h, i) => (
            <HistoryRow
              key={i}
              h={h}
              onClick={() => openHistoryPopup(patient, h)}
              isLast={i === history.length - 1}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}

const HISTORY_GRID = '90px 50px minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1.2fr) 16px';

function HistoryRow({ h, onClick, isLast }) {
  return (
    <div
      onClick={onClick}
      className="grid items-baseline px-2 py-2 row-hover transition cursor-pointer"
      style={{
        gridTemplateColumns: HISTORY_GRID,
        columnGap: 8,
        borderBottom: isLast ? 'none' : '1px solid var(--rl-border-soft)',
      }}
    >
      <div className="font-mono text-xs" style={{ color: 'var(--rl-ink)' }}>{h.date}</div>
      <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>{h.visit}</div>
      <div className="text-xs truncate" style={{ color: 'var(--rl-ink)' }}>{h.complaint}</div>
      <div className="text-xs truncate" style={{ color: 'var(--rl-primary)', fontWeight: 500 }}>{h.dx}</div>
      <div className="text-xs truncate" style={{ color: 'var(--rl-ink-2)' }}>{h.tx}</div>
      <ChevronRight size={12} style={{ color: 'var(--rl-ink-3)' }} />
    </div>
  );
}

/* History 상세 popup · 새 창 */
function openHistoryPopup(patient, h) {
  const w = window.open('', `hx-${patient.mrn}-${h.date}`, 'width=720,height=820,resizable=yes,scrollbars=yes');
  if (!w) {
    alert('팝업 차단을 해제해주세요.');
    return;
  }
  const sex = patient.sex === 'M' ? '남' : '여';
  w.document.write(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>방문 상세 · ${patient.name} · ${h.date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html, body { margin: 0; padding: 0; }
  body { background: #F8FAFC; font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif; color: #0A1628; padding: 24px; -webkit-font-smoothing: antialiased; }
  .card { background: white; max-width: 640px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 6px; padding: 24px; }
  .header { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid #E2E8F0; }
  .header .name { font-family: 'IBM Plex Serif', serif; font-size: 20px; }
  .header .meta { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #64748B; }
  .header .label { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #0C447C; }
  .visit { display: flex; align-items: baseline; gap: 12px; margin: 16px 0; padding: 10px 12px; background: #EFF4FB; border-left: 3px solid #0C447C; }
  .visit .date { font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 600; }
  .visit .type { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; }
  .visit .by { margin-left: auto; font-size: 11px; color: #334155; }
  .section { margin-bottom: 14px; }
  .section .title { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; margin-bottom: 4px; }
  .section .body { font-size: 13px; line-height: 1.6; }
  .section.dx .body { color: #0C447C; font-weight: 500; }
  .section.tx .body { color: #0E8574; font-weight: 500; }
  .vitals { font-family: 'IBM Plex Mono', monospace; font-size: 12px; padding: 8px 10px; background: #F1F5F9; border-radius: 4px; }
  .footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <span class="name">${patient.name}</span>
      <span class="meta">${sex} · ${patient.age}세 · ${patient.mrn}</span>
      <span class="label">방문 상세</span>
    </div>
    <div class="visit">
      <span class="date">${h.date}</span>
      <span class="type">${h.visit}</span>
      <span class="by">담당 · ${h.physician || '정민수 과장'}</span>
    </div>

    <div class="section"><div class="title">주호소 · Chief Complaint</div><div class="body">${h.complaint}</div></div>

    ${h.vitals ? `<div class="section"><div class="title">활력 징후 · Vitals</div><div class="vitals">${h.vitals}</div></div>` : ''}

    <div class="section dx"><div class="title">진단 · Diagnosis</div><div class="body">${h.dx}</div></div>

    <div class="section tx"><div class="title">처방 · Treatment</div><div class="body">${h.tx}</div></div>

    ${h.notes ? `<div class="section"><div class="title">진료 메모 · Notes</div><div class="body">${h.notes}</div></div>` : ''}

    <div class="footer">
      <span>Soo-Pul · Visit Detail</span>
      <span>EU AI Act Art. 22</span>
    </div>
  </div>
</body>
</html>`);
  w.document.close();
}

function InfoCell({ label, value, mono, compact }) {
  const valueClass = compact ? 'text-xs' : 'text-sm';
  const labelClass = compact ? 'text-[9px]' : 'text-[10px]';
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className={`font-mono ${labelClass} uppercase tracking-widest mb-0.5 truncate`}
        style={{ color: 'var(--rl-ink-3)' }}
      >
        {label}
      </div>
      <div
        className={`${valueClass} ${mono ? 'font-mono' : ''} truncate`}
        style={{ color: 'var(--rl-ink)', whiteSpace: 'nowrap' }}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

/* SVG markup builder · 원본 / heatmap 두 종류 동적 생성 */
const CXR_RIB_YS = [50, 65, 80, 95, 110, 125, 140];

/* CheXpert 14 label별 Grad-CAM 초점 영역 (200x200 SVG 좌표계) — mock heatmap */
const LABEL_FOCAL_REGIONS = {
  'Cardiomegaly':                [{ cx: 100, cy: 118, rx: 40, ry: 40 }],
  'Lung Opacity':                [{ cx: 65, cy: 130, rx: 28, ry: 22 }, { cx: 140, cy: 128, rx: 22, ry: 18 }],
  'Lung Lesion':                 [{ cx: 62, cy: 72, rx: 14, ry: 14 }],
  'Edema':                       [{ cx: 60, cy: 105, rx: 32, ry: 28 }, { cx: 145, cy: 105, rx: 32, ry: 28 }],
  'Consolidation':               [{ cx: 142, cy: 152, rx: 32, ry: 24 }],
  'Pneumonia':                   [{ cx: 140, cy: 150, rx: 34, ry: 26 }],
  'Atelectasis':                 [{ cx: 60, cy: 155, rx: 18, ry: 14 }],
  'Pneumothorax':                [{ cx: 158, cy: 55, rx: 24, ry: 32 }],
  'Pleural Effusion':            [{ cx: 60, cy: 172, rx: 36, ry: 13 }],
  'Pleural Other':               [{ cx: 25, cy: 130, rx: 12, ry: 35 }],
  'Fracture':                    [{ cx: 62, cy: 62, rx: 14, ry: 8 }],
  'Support Devices':             [{ cx: 100, cy: 80, rx: 8, ry: 30 }],
  'Enlarged Cardiomediastinum':  [{ cx: 100, cy: 100, rx: 42, ry: 50 }],
};
// (이전: DEFAULT_FOCAL = Lung Opacity 폴백 — 양성 라벨 없어도 항상 Lung Opacity heatmap 표시되어
//  사용자 혼동. 제거하고 양성 라벨 없으면 "이상 없음" 텍스트 표시.)

function buildCxrSvg({ heatmap = false, focalRegions = null, labelName = null, notAnalyzed = false } = {}) {
  const regions = Array.isArray(focalRegions) ? focalRegions : [];
  // heatmap 3-state:
  //   notAnalyzed       → "분석 미완료" 마크 (분석 자체를 안 함)
  //   region 없음(정상) → "이상 없음" 마크 (분석했고 양성 label 없음)
  //   region 있음        → hotspot heatmap
  const pending   = heatmap && notAnalyzed;
  const noFinding = heatmap && !notAnalyzed && regions.length === 0;
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;">
  <defs>
    <radialGradient id="lung-${heatmap ? 'h' : 'o'}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#2C3E50" />
      <stop offset="100%" stop-color="#0A1628" />
    </radialGradient>
    ${heatmap && !noFinding && !pending ? `
    <radialGradient id="hot-l" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(255,80,40,0.85)" />
      <stop offset="55%" stop-color="rgba(255,160,30,0.45)" />
      <stop offset="100%" stop-color="rgba(255,200,40,0)" />
    </radialGradient>
    <radialGradient id="hot-r" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(255,90,60,0.7)" />
      <stop offset="60%" stop-color="rgba(255,170,40,0.35)" />
      <stop offset="100%" stop-color="rgba(255,200,40,0)" />
    </radialGradient>` : ''}
  </defs>
  <rect x="0" y="0" width="200" height="200" fill="url(#lung-${heatmap ? 'h' : 'o'})" />
  <line x1="100" y1="20" x2="100" y2="180" stroke="rgba(255,255,255,0.35)" stroke-width="3" />
  ${CXR_RIB_YS.map(y => `<path d="M 100 ${y} Q 50 ${y+15}, 25 ${y+10}" stroke="rgba(255,255,255,0.2)" stroke-width="1" fill="none" />`).join('')}
  ${CXR_RIB_YS.map(y => `<path d="M 100 ${y} Q 150 ${y+15}, 175 ${y+10}" stroke="rgba(255,255,255,0.2)" stroke-width="1" fill="none" />`).join('')}
  <ellipse cx="108" cy="115" rx="22" ry="30" fill="rgba(255,255,255,0.08)" />
  <path d="M 20 160 Q 60 150, 98 158 Q 140 165, 180 155" stroke="rgba(255,255,255,0.25)" stroke-width="1.2" fill="none" />
  ${heatmap && !noFinding && !pending ? `
  ${regions.map((r, i) => `<ellipse cx="${r.cx}" cy="${r.cy}" rx="${r.rx}" ry="${r.ry}" fill="url(#hot-${i % 2 === 0 ? 'l' : 'r'})" />`).join('')}
  <line x1="0" y1="95" x2="200" y2="95" stroke="rgba(77,212,245,0.3)" stroke-width="0.5" stroke-dasharray="2 2" />
  <text x="160" y="14" fill="rgba(255,180,60,0.95)" font-size="6" font-family="monospace">HEATMAP</text>
  ${labelName ? `<text x="100" y="194" fill="rgba(255,180,60,0.95)" font-size="7" font-family="monospace" text-anchor="middle">${labelName}</text>` : ''}
  ` : ''}
  ${noFinding ? `
  <text x="160" y="14" fill="rgba(14,133,116,0.95)" font-size="6" font-family="monospace">HEATMAP</text>
  <rect x="40" y="85" width="120" height="32" rx="4" fill="rgba(14,133,116,0.12)" stroke="rgba(14,133,116,0.5)" stroke-width="0.6" />
  <text x="100" y="100" fill="rgba(14,133,116,0.95)" font-size="9" font-family="IBM Plex Sans KR, monospace" text-anchor="middle" font-weight="600">이상 없음</text>
  <text x="100" y="111" fill="rgba(14,133,116,0.75)" font-size="5" font-family="monospace" text-anchor="middle">No abnormal finding · all labels &lt; 0.5</text>
  ` : ''}
  ${pending ? `
  <text x="150" y="14" fill="rgba(255,255,255,0.5)" font-size="6" font-family="monospace">HEATMAP</text>
  <rect x="36" y="84" width="128" height="34" rx="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.32)" stroke-width="0.6" stroke-dasharray="3 2" />
  <text x="100" y="99" fill="rgba(255,255,255,0.9)" font-size="9" font-family="IBM Plex Sans KR, monospace" text-anchor="middle" font-weight="600">분석 미완료</text>
  <text x="100" y="111" fill="rgba(255,255,255,0.55)" font-size="5" font-family="monospace" text-anchor="middle">CXR AI analysis not completed</text>
  ` : ''}
  <text x="8" y="14" fill="rgba(255,255,255,0.55)" font-size="6" font-family="monospace">CXR · Frontal</text>
  ${labelName || noFinding || pending ? '' : '<text x="8" y="193" fill="rgba(255,255,255,0.4)" font-size="6" font-family="monospace">448 × 448 · resized</text>'}
</svg>`;
}

/* ----------- CXR · 실제 이미지 우선, 없으면 mock SVG -----------
 * study.imageUrl 있으면 <img> 로 렌더 (cheXpert · CloudFront 가 S3 라우팅).
 * heatmap 토글 시 절반 투명한 SVG overlay 를 위에 겹침.
 * 이미지 로드 실패하면 자동으로 CxrMock 폴백.
 * --------------------------------------------------------------- */
function CxrViewer({ study, heatmap = false, focalRegions = null, labelName = null }) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [study?.imageUrl]);

  if (!study?.imageUrl || errored) {
    return <CXRMock heatmap={heatmap} focalRegions={focalRegions} labelName={labelName} />;
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <img
        src={study.imageUrl}
        alt={`CXR ${study.studyId || ''}`}
        onError={() => setErrored(true)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: '#0A1628',
        }}
      />
      {heatmap && (
        // 실제 grad-cam 이 결선되기 전까지는 mock heatmap 을 부분 투명으로 overlay
        <div style={{ position: 'absolute', inset: 0, opacity: 0.55, pointerEvents: 'none' }}>
          <CXRMock heatmap={true} focalRegions={focalRegions} labelName={labelName} />
        </div>
      )}
    </div>
  );
}

function CXRMock({ heatmap = false, focalRegions = null, labelName = null }) {
  return (
    <div
      style={{ width: '100%', height: '100%' }}
      dangerouslySetInnerHTML={{ __html: buildCxrSvg({ heatmap, focalRegions, labelName }) }}
    />
  );
}

/* CXR 확대 보기 · 새 창 (window.open popup) · 좌우 비교 (원본 vs Heatmap)
 *
 * @param patient   환자 객체 (이름·MRN·메타용)
 * @param study     선택된 CXR study (시점 셀렉터에서 고른 것). 없으면 latest 폴백.
 */
function openCxrPopup(patient, study) {
  const w = window.open('', `cxr-${patient.mrn}`, 'width=1440,height=860,resizable=yes,scrollbars=no');
  if (!w) {
    alert('팝업 차단을 해제해주세요.');
    return;
  }
  const sex = patient.sex === 'M' ? '남' : '여';
  const date = patient.visitDate || '오늘 (2026-04-23)';
  const meta = `${sex} · ${patient.age}세 · ${patient.mrn} · ${date} ${patient.time}`;

  // 선택된 시점 study (없으면 latest) — popup 은 about:blank origin 이라 absolute 화
  const studies = normalizeCxrStudies(patient);
  const selected = study || studies[0] || null;
  const imgUrl = selected && selected.imageUrl
    ? `${window.location.origin}${selected.imageUrl}`
    : null;
  // popup 헤더 메타에 어떤 시점인지 명시
  const studyMeta = selected && selected.capturedAt
    ? ` · 촬영 ${String(selected.capturedAt).replace('T', ' ').slice(0, 19)}`
    : '';
  const originalHtml = imgUrl
    ? `<img src="${imgUrl}" alt="CXR" style="width:100%;height:100%;object-fit:contain;display:block;background:#0A1628" />`
    : buildCxrSvg({ heatmap: false });

  // heatmap 3-state — 분석 미완료 / 이상 없음 / label heatmap
  //   분석 미완료(status≠ready)        → "분석 미완료"
  //   분석 완료 + 양성 label 없음(정상) → "이상 없음"
  //   분석 완료 + 양성 label 있음       → 최고 % label heatmap
  const cxrAnalyzed = patient.status === 'ready';
  // 양성 라벨 + 라벨별 heatmap (이미지 있으면 SVG 오버레이만, 없으면 SVG 자체)
  const allLabels = cxrAnalyzed ? deriveChexpertLabels(patient) : [];
  const positiveLabels = allLabels.filter(l => l.score >= 0.5);  // score desc 정렬됨
  const topPositive = positiveLabels[0] || null;                 // 최고 % label
  // 기본 heatmap 3-state:
  //   분석 미완료        → "분석 미완료"
  //   분석 완료 + 양성   → 최고 % label heatmap (디폴트로 바로 표시)
  //   분석 완료 + 정상   → "이상 없음"
  const defaultHeatmap = !cxrAnalyzed
    ? buildCxrSvg({ heatmap: true, notAnalyzed: true })
    : topPositive
    ? buildCxrSvg({ heatmap: true, labelName: topPositive.name,
                    focalRegions: LABEL_FOCAL_REGIONS[topPositive.name] || null })
    : buildCxrSvg({ heatmap: true });
  const defaultLabelText = !cxrAnalyzed
    ? 'Heatmap · 분석 미완료'
    : topPositive ? `Heatmap · ${topPositive.name}` : 'Heatmap';
  const heatmapsByLabel = { default: defaultHeatmap };
  positiveLabels.forEach(l => {
    heatmapsByLabel[l.name] = buildCxrSvg({
      heatmap: true,
      focalRegions: LABEL_FOCAL_REGIONS[l.name] || null,
      labelName: l.name,
    });
  });
  const labelButtonsHtml = !cxrAnalyzed
    ? `<div class="empty">CXR AI 분석 미완료 · 분석 후 양성 label 이 표시됩니다</div>`
    : positiveLabels.length === 0
    ? `<div class="empty">양성 소견 없음 (모두 &lt; 0.50)</div>`
    : positiveLabels.map(l => `
        <button class="label-btn" data-name="${l.name}" onclick="selectLabel('${l.name.replace(/'/g, "\\'")}')">
          <div class="row">
            <span class="name">${l.name}</span>
            <span class="score">${(l.score * 100).toFixed(0)}%</span>
          </div>
          <div class="bar"><div class="fill" style="width:${Math.round(l.score * 100)}%"></div></div>
        </button>`).join('');
  w.document.write(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>CXR · ${patient.name} · ${patient.mrn} · 비교</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: #0A1628; color: #fff;
    font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif;
    display: flex; flex-direction: column; height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  header {
    padding: 14px 20px;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    display: flex; align-items: baseline; gap: 12px;
  }
  header .label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em;
    color: #4DD4F5;
  }
  header .name { font-family: 'IBM Plex Serif', serif; font-size: 20px; letter-spacing: -0.01em; }
  header .meta { font-family: 'IBM Plex Mono', monospace; font-size: 11px; opacity: 0.6; }
  header .spacer { flex: 1; }
  header .reanalyze-btn {
    background: rgba(180,83,9,0.18);
    border: 1px solid rgba(180,83,9,0.7);
    color: #FFB459;
    padding: 5px 12px;
    border-radius: 4px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    transition: background 0.15s;
  }
  header .reanalyze-btn:hover { background: rgba(180,83,9,0.32); }
  header .reanalyze-btn:active { background: rgba(180,83,9,0.5); }
  main {
    flex: 1; min-height: 0;
    display: grid; grid-template-columns: 240px 1fr 1fr; gap: 16px;
    padding: 16px 20px;
  }
  .pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .pane .caption {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em;
    margin-bottom: 6px; display: flex; align-items: center; gap: 8px;
    height: 14px; white-space: nowrap; overflow: hidden;
  }
  .pane.original .caption { color: rgba(255,255,255,0.7); }
  .pane.heatmap  .caption { color: rgba(255,180,60,0.95); }
  .pane .caption .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pane.original .dot { background: rgba(255,255,255,0.7); }
  .pane.heatmap  .dot { background: rgba(255,180,60,0.95); }
  .pane .frame {
    flex: 1; min-height: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .pane .frame > div {
    height: 100%; aspect-ratio: 1 / 1; max-width: 100%;
    border: 1px solid rgba(255,255,255,0.18); border-radius: 4px;
    overflow: hidden;
  }
  .pane.heatmap .frame > div { border-color: rgba(255,180,60,0.4); }
  /* Zoom — 휠 줌·드래그 팬, 두 패널 연동 */
  .pane .frame { overflow: hidden; }
  .pane .frame > div { transform-origin: center center; transition: transform 0.05s linear; will-change: transform; }
  .pane .frame.dragging > div { transition: none; }
  /* Header zoom toolbar */
  header .zoom-tools { display: flex; align-items: center; gap: 4px; margin-left: 14px; }
  header .zoom-tools button {
    width: 26px; height: 24px; padding: 0;
    background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85);
    border: 1px solid rgba(255,255,255,0.18); border-radius: 3px;
    font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 600;
    cursor: pointer; transition: background 0.12s;
    display: flex; align-items: center; justify-content: center;
  }
  header .zoom-tools button:hover { background: rgba(255,255,255,0.18); }
  header .zoom-tools button:active { background: rgba(255,255,255,0.28); }
  header #zoom-label {
    font-family: 'IBM Plex Mono', monospace; font-size: 10px;
    color: rgba(255,255,255,0.55); margin-left: 6px; min-width: 38px; text-align: center;
  }

  /* Left sidebar — 양성 label 리스트 */
  .sidebar {
    display: flex; flex-direction: column; min-height: 0; gap: 6px;
    overflow-y: auto;
  }
  .sidebar .head {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em;
    color: rgba(255,255,255,0.55);
    flex-shrink: 0;
  }
  .sidebar .empty {
    font-size: 11px; padding: 8px 0;
    color: rgba(255,255,255,0.4);
  }
  .label-btn {
    text-align: left; cursor: pointer;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 4px;
    padding: 8px 10px;
    color: rgba(255,255,255,0.85);
    font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .label-btn:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.2);
  }
  .label-btn.active {
    background: rgba(180,83,9,0.22);
    border-color: rgba(180,83,9,0.7);
    color: #FFB459;
  }
  .label-btn .row {
    display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px;
  }
  .label-btn .name {
    font-size: 12px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
  }
  .label-btn .score {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px; flex-shrink: 0;
    color: rgba(255,120,80,0.95);
  }
  .label-btn.active .score { color: #FFB459; }
  .label-btn .bar {
    height: 3px; border-radius: 2px;
    background: rgba(255,255,255,0.08); overflow: hidden;
  }
  .label-btn .bar .fill {
    height: 100%; background: rgba(255,120,80,0.85);
  }
  .label-btn.active .bar .fill { background: #FFB459; }
  .clear-btn {
    margin-top: 4px; padding: 6px 8px; cursor: pointer;
    background: transparent;
    border: 1px solid rgba(255,180,60,0.4);
    border-radius: 4px;
    color: #FFB459;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    text-align: center;
  }
  .clear-btn:hover { background: rgba(180,83,9,0.15); }
  .clear-btn.hidden { display: none; }
  .sidebar .hint {
    margin-top: auto; padding-top: 8px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: rgba(255,255,255,0.4);
    flex-shrink: 0;
  }

  footer {
    padding: 8px 20px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; opacity: 0.55;
    border-top: 1px solid rgba(255,255,255,0.1);
    text-align: center;
  }
</style>
</head>
<body>
  <header>
    <span class="label">CXR · Frontal · 비교 보기</span>
    <div class="zoom-tools" title="휠 줌 · 확대 시 드래그 팬">
      <button id="zoom-out" title="축소 (Wheel ↓)">−</button>
      <button id="zoom-reset" title="100% 복귀">⟲</button>
      <button id="zoom-in" title="확대 (Wheel ↑)">+</button>
      <span id="zoom-label">100%</span>
    </div>
    <button class="reanalyze-btn" onclick="if(window.opener){window.opener.postMessage({type:'rare-link:reanalyze-cxr',mrn:'${patient.mrn}'},'*');} window.close();" title="이미지 재분석 요청 후 창 닫기">↻ 재분석</button>
    <span class="spacer"></span>
    <span class="name">${patient.name}</span>
    <span class="meta">${meta}${studyMeta}</span>
  </header>
  <main>
    <aside class="sidebar">
      <div class="head">양성 label · ${positiveLabels.length}건</div>
      ${labelButtonsHtml}
      <button class="clear-btn hidden" id="clear-btn" onclick="selectLabel(null)">✕ 기본 heatmap</button>
      <div class="hint">클릭 시 우측 heatmap 초점이 해당 label로 전환됩니다.</div>
    </aside>
    <div class="pane original">
      <div class="caption"><span class="dot"></span>원본 · Original</div>
      <div class="frame"><div style="position:relative;background:#0A1628">${originalHtml}</div></div>
    </div>
    <div class="pane heatmap">
      <div class="caption"><span class="dot"></span><span id="heatmap-label">${defaultLabelText}</span></div>
      <div class="frame"><div style="position:relative;background:#0A1628">
        ${imgUrl ? `<img src="${imgUrl}" alt="CXR" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block" />` : ''}
        <div id="heatmap-svg" style="${imgUrl ? 'position:absolute;inset:0;opacity:0.55;pointer-events:none' : ''}">${defaultHeatmap}</div>
      </div></div>
    </div>
  </main>
  <footer>Soo-Pul · 본 영상은 진단 보조용입니다 · EU AI Act Art. 22</footer>
  <script type="application/json" id="heatmap-data">${JSON.stringify(heatmapsByLabel).replace(/<\/script/gi, '<\\/script')}</script>
  <script>
    (function() {
      var heatmaps = JSON.parse(document.getElementById('heatmap-data').textContent);
      var defaultLabelText = ${JSON.stringify(defaultLabelText)};
      window.selectLabel = function(name) {
        var svg = (name && heatmaps[name]) ? heatmaps[name] : heatmaps['default'];
        document.getElementById('heatmap-svg').innerHTML = svg;
        document.getElementById('heatmap-label').textContent =
          name ? 'Heatmap · ' + name : defaultLabelText;
        var btns = document.querySelectorAll('.label-btn');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('data-name') === name) btns[i].classList.add('active');
          else btns[i].classList.remove('active');
        }
        var clear = document.getElementById('clear-btn');
        if (name) clear.classList.remove('hidden');
        else clear.classList.add('hidden');
      };
    })();

    /* X-ray 확대/축소/팬 — 휠 줌, 드래그 팬, 두 패널 연동 */
    (function() {
      var scale = 1, tx = 0, ty = 0;
      var MIN = 0.5, MAX = 6, STEP = 1.18;
      var wraps = document.querySelectorAll('.pane .frame > div');
      var frames = document.querySelectorAll('.pane .frame');
      var label = document.getElementById('zoom-label');
      function apply() {
        var t = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
        for (var i = 0; i < wraps.length; i++) wraps[i].style.transform = t;
        for (var j = 0; j < frames.length; j++) frames[j].style.cursor = scale > 1 ? 'grab' : 'default';
        if (label) label.textContent = Math.round(scale * 100) + '%';
      }
      function setScale(s) { scale = Math.max(MIN, Math.min(MAX, s)); if (scale === 1) { tx = 0; ty = 0; } apply(); }
      function reset() { scale = 1; tx = 0; ty = 0; apply(); }
      frames.forEach(function(frame) {
        frame.addEventListener('wheel', function(e) {
          e.preventDefault();
          var d = e.deltaY < 0 ? STEP : 1 / STEP;
          setScale(scale * d);
        }, { passive: false });
        var drag = null;
        frame.addEventListener('mousedown', function(e) {
          if (scale <= 1) return;
          drag = { x: e.clientX - tx, y: e.clientY - ty };
          frame.classList.add('dragging');
          frame.style.cursor = 'grabbing';
          e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
          if (!drag) return;
          tx = e.clientX - drag.x; ty = e.clientY - drag.y;
          apply();
        });
        window.addEventListener('mouseup', function() {
          if (!drag) return;
          drag = null;
          frame.classList.remove('dragging');
          frame.style.cursor = scale > 1 ? 'grab' : 'default';
        });
      });
      document.getElementById('zoom-in').addEventListener('click', function() { setScale(scale * STEP); });
      document.getElementById('zoom-out').addEventListener('click', function() { setScale(scale / STEP); });
      document.getElementById('zoom-reset').addEventListener('click', reset);
      // 키보드 단축키 — +/-/0
      window.addEventListener('keydown', function(e) {
        if (e.key === '+' || e.key === '=') setScale(scale * STEP);
        else if (e.key === '-' || e.key === '_') setScale(scale / STEP);
        else if (e.key === '0') reset();
      });
    })();
  </script>
</body>
</html>`);
  w.document.close();
}

function DxPreviewRow({ rank, name, prob, rare, dontMiss, orpha, onClick, kind = 'ranking' }) {
  // kind: 'ranking' = Phase 3·4 일반/기타 질환 (통합 스코어, primary 색)
  //       'rare'    = Phase 5 희귀질환 listing (LR, rare 보라색)
  const isRare = kind === 'rare';
  const accent = isRare ? 'var(--rl-rare)' : 'var(--rl-primary)';
  const accentSoft = isRare ? 'var(--rl-rare-soft)' : 'var(--rl-primary-soft)';
  // 일반 질환 = "통합 스코어" / 희귀질환 = "LR" (사후확률 기반)
  const metricLabel = isRare ? 'LR' : '통합 스코어';
  return (
    <div
      onClick={onClick}
      className={`hairline-strong rounded px-3 py-2.5 transition ${onClick ? 'cursor-pointer hover:bg-slate-50' : ''}`}
      style={{
        borderLeft: dontMiss ? '3px solid var(--rl-amber)'
                  : isRare    ? '3px solid var(--rl-rare)'
                              : undefined,
        background: isRare ? accentSoft : undefined,
      }}
      title={onClick ? (isRare ? 'LIRICAL LR 계산 근거 보기' : '통합 스코어 계산 근거 보기') : undefined}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>#{rank}</div>
        <div className="text-sm font-medium flex-1 min-w-0 truncate" style={{ color: 'var(--rl-ink)' }}>{name}</div>
        <div className="font-serif text-base leading-none" style={{ color: accent }}>{(prob * 100).toFixed(0)}<span className="text-[10px]">%</span></div>
        {onClick && <ArrowUpRight size={11} style={{ color: accent }} />}
      </div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          {metricLabel}
        </span>
      </div>
      <div className="h-1 rounded-full mb-1.5" style={{ background: 'var(--rl-bg-3)' }}>
        <div className="h-full rounded-full" style={{ width: prob * 100 + '%', background: accent }} />
      </div>
      <div className="flex items-center gap-1.5">
        {isRare && (
          <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
            <Flame size={9} /> 희귀질환
          </span>
        )}
        {dontMiss && (
          <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
            <AlertTriangle size={9} /> Don't miss
          </span>
        )}
        {orpha && <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{orpha}</span>}
      </div>
    </div>
  );
}

/* ----------- DX EVIDENCE · LR 계산 근거 popup ----------- */
function buildDxEvidence(patient, dx) {
  // 환자 주호소에서 HPO term 추출 (mock)
  const c = patient.complaint || '';
  const candidate = [
    [/호흡곤란/, { id: 'HP:0002094', label: 'Dyspnea (호흡곤란)',          lr: 4.2 }],
    [/마른\s*기침|마른기침/, { id: 'HP:0031246', label: 'Nonproductive cough (마른기침)', lr: 3.6 }],
    [/기침/, { id: 'HP:0012735', label: 'Cough (기침)',                   lr: 2.1 }],
    [/체중감소/, { id: 'HP:0001824', label: 'Weight loss (체중감소)',     lr: 2.6 }],
    [/객혈/,    { id: 'HP:0002105', label: 'Hemoptysis (객혈)',           lr: 6.4 }],
    [/객담/,    { id: 'HP:0033709', label: 'Productive cough (객담)',     lr: 1.9 }],
    [/흉통/,    { id: 'HP:0100749', label: 'Chest pain (흉통)',           lr: 1.8 }],
    [/발한/,    { id: 'HP:0000989', label: 'Night sweats (야간 발한)',    lr: 3.2 }],
    [/기흉/,    { id: 'HP:0002107', label: 'Pneumothorax (기흉)',         lr: 8.5 }],
    [/관절염/,  { id: 'HP:0001370', label: 'Rheumatoid arthritis (RA)',   lr: 5.5 }],
    [/부종/,    { id: 'HP:0000969', label: 'Edema (부종)',                lr: 2.3 }],
    [/두근거림/, { id: 'HP:0001962', label: 'Palpitations (두근거림)',    lr: 1.6 }],
    [/면역결핍/, { id: 'HP:0002721', label: 'Immunodeficiency',           lr: 7.2 }],
  ];
  const observed = candidate.filter(([re]) => re.test(c)).map(([, t]) => ({ ...t, state: 'observed' }));
  // 보조 (미관찰) HPO 1-2개 추가 (대조용)
  const supplementary = [
    { id: 'HP:0030828', label: 'Velcro crackles (벨크로 수포음)', lr: 1.0, state: 'unknown' },
    { id: 'HP:0006510', label: 'Chronic pulmonary obstruction',   lr: 1.0, state: 'unknown' },
  ].slice(0, 2 - Math.min(2, observed.length === 0 ? 2 : 0));
  const hpoTerms = [...observed, ...supplementary];

  // CXR DenseNet score
  const cxrScore = Math.min(0.95, dx.prob * 0.85 + 0.10);

  // Combined LR (관찰된 것 곱)
  const combinedHpoLr = observed.reduce((p, t) => p * t.lr, 1);
  // Prior odds (희귀질환은 낮음)
  const priorProb = dx.rare ? 0.0001 : 0.005;
  const priorOdds = priorProb / (1 - priorProb);
  // Posterior odds = prior × combined LR × CXR LR (CXR LR 근사 = score / (1-score))
  const cxrLr = (cxrScore / Math.max(0.05, 1 - cxrScore));
  const postOdds = priorOdds * combinedHpoLr * cxrLr;
  const postProb = postOdds / (1 + postOdds);

  // Refs (dx별)
  const refs = ['Robinson PN et al. Am J Hum Genet 2020;107:403-417 (LIRICAL · LR paradigm)'];
  if (/IPF|섬유증/.test(dx.name))     refs.push('Raghu G et al. ATS/ERS/JRS/ALAT IPF Guideline. Am J Respir Crit Care Med 2022;205:e18-e47');
  if (/Sarcoidosis/.test(dx.name))    refs.push('Crouser ED et al. ATS Sarcoidosis Guideline. Am J Respir Crit Care Med 2020;201:e26-e51');
  if (/LAM|Langerhans/.test(dx.name)) refs.push('Gupta N et al. ATS/JRS LAM Guideline. Am J Respir Crit Care Med 2017;196:1337-1348');
  if (/Pneumonia|폐렴/.test(dx.name)) refs.push('Metlay JP et al. ATS/IDSA CAP Guideline. Am J Respir Crit Care Med 2019;200:e45-e67');
  if (/CHF|Heart Failure/.test(dx.name)) refs.push('Heidenreich PA et al. AHA/ACC/HFSA HF Guideline. Circulation 2022;145:e895-e1032');
  if (/RA-associated|NSIP/.test(dx.name)) refs.push('Travis WD et al. ATS/ERS NSIP Statement. Am J Respir Crit Care Med 2008;177:1338-1347');

  return {
    prevalence: dx.rare ? '< 5 / 100,000' : '~ 50 / 100,000',
    priorProb, priorOdds,
    hpoTerms, observedCount: observed.length,
    cxrScore, cxrLr,
    combinedHpoLr,
    postOdds, postProb,
    refs,
  };
}

/* 일반/기타 질환 (Phase 3·4) — 다중모달 가중 스코어 근거.
 * LR (Likelihood Ratio) 은 희귀질환 listing (Phase 5) 전용 — 여기선 사용 안 함. */
function buildCommonDxEvidence(patient, dx) {
  const c = patient.complaint || '';
  // 주호소에서 HPO 증상 추출 — 매칭 여부만 (LR 미사용)
  const candidate = [
    [/호흡곤란/,             { id: 'HP:0002094', label: 'Dyspnea (호흡곤란)' }],
    [/마른\s*기침|마른기침/, { id: 'HP:0031246', label: 'Nonproductive cough (마른기침)' }],
    [/기침/,                 { id: 'HP:0012735', label: 'Cough (기침)' }],
    [/체중감소/,             { id: 'HP:0001824', label: 'Weight loss (체중감소)' }],
    [/객혈/,                 { id: 'HP:0002105', label: 'Hemoptysis (객혈)' }],
    [/객담/,                 { id: 'HP:0033709', label: 'Productive cough (객담)' }],
    [/흉통/,                 { id: 'HP:0100749', label: 'Chest pain (흉통)' }],
    [/발한/,                 { id: 'HP:0000989', label: 'Night sweats (야간 발한)' }],
    [/부종/,                 { id: 'HP:0000969', label: 'Edema (부종)' }],
  ];
  const observed = candidate.filter(([re]) => re.test(c)).map(([, t]) => t);

  // Phase 3 다중모달 가중치 (disease profile weight — S/L/R/M 4축)
  const weights = { S: 0.25, L: 0.20, R: 0.35, M: 0.20 };
  // 각 축 매칭 점수 0~1 (mock — backend 결선 시 phase3_integrated_ranking.scoring 으로 대체)
  const axisR = Math.min(0.97, dx.prob * 0.9 + 0.07);          // 영상 (CXR DenseNet)
  const axisS = Math.min(1, observed.length / 4) * 0.6 + dx.prob * 0.35;  // 증상 (HPO)
  const axisL = dx.prob * 0.55;                                 // 검사 (lab)
  const axisM = 0.08;                                           // 미생물
  const axes = [
    { key: 'R', name: '영상 (CXR · DenseNet-121)', score: axisR, weight: weights.R },
    { key: 'S', name: '증상 (HPO 매칭)',           score: axisS, weight: weights.S },
    { key: 'L', name: '검사 (Lab)',                score: axisL, weight: weights.L },
    { key: 'M', name: '미생물 (Micro)',            score: axisM, weight: weights.M },
  ];
  const integrated = axes.reduce((sum, a) => sum + a.score * a.weight, 0);

  // Phase 4 LLM rerank — mock
  const p4Confidence = dx.prob >= 0.7 ? 'HIGH' : dx.prob >= 0.45 ? 'MEDIUM' : 'LOW';
  const p4Agree = dx.prob >= 0.5;

  const refs = ['lung_disease_profiles v3_6 · 다중모달 가중 스코어링 (S/L/R/M 4축)'];
  if (/IPF|섬유증/.test(dx.name))     refs.push('Raghu G et al. ATS/ERS/JRS/ALAT IPF Guideline. Am J Respir Crit Care Med 2022;205:e18-e47');
  if (/Sarcoidosis/.test(dx.name))    refs.push('Crouser ED et al. ATS Sarcoidosis Guideline. Am J Respir Crit Care Med 2020;201:e26-e51');
  if (/Pneumonia|폐렴/.test(dx.name)) refs.push('Metlay JP et al. ATS/IDSA CAP Guideline. Am J Respir Crit Care Med 2019;200:e45-e67');
  if (/HP|과민성/.test(dx.name))      refs.push('Raghu G et al. ATS/JRS/ALAT HP Guideline. Am J Respir Crit Care Med 2020;202:e36-e69');

  return { observed, axes, integrated, p4Confidence, p4Agree, refs };
}

function openCommonDxEvidencePopup(patient, dx, rank) {
  const w = window.open('', `dx-c-${patient.mrn}-${rank}`, 'width=900,height=900,resizable=yes,scrollbars=yes');
  if (!w) { alert('팝업 차단을 해제해주세요.'); return; }
  const ev = buildCommonDxEvidence(patient, dx);
  const sex = patient.sex === 'M' ? '남' : '여';

  const axisRows = ev.axes.map(a => `
    <tr>
      <td class="mono"><b>${a.key}</b></td>
      <td>${a.name}</td>
      <td class="right mono">${(a.score * 100).toFixed(0)}%</td>
      <td class="right mono muted">× ${a.weight.toFixed(2)}</td>
      <td class="right mono"><b>${(a.score * a.weight * 100).toFixed(1)}</b></td>
    </tr>`).join('');

  const hpoRows = ev.observed.length
    ? ev.observed.map(t => `<tr><td class="mono">${t.id}</td><td>${t.label}</td><td><span class="chip teal">관찰</span></td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">주호소에서 추출된 HPO 증상 없음</td></tr>';

  const refList = ev.refs.map(r => `<li>${r}</li>`).join('');
  const flagBadges = [
    dx.dontMiss ? '<span class="chip amber">Don\'t miss</span>' : '',
  ].filter(Boolean).join(' ');

  w.document.write(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<title>${dx.name} · 통합 스코어 근거</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html,body{margin:0;padding:0;}
  body{background:#F8FAFC;font-family:'IBM Plex Sans KR',sans-serif;color:#0A1628;padding:24px;-webkit-font-smoothing:antialiased;}
  .card{background:white;max-width:760px;margin:0 auto;border:1px solid #E2E8F0;border-radius:6px;padding:28px;}
  h1{font-family:'IBM Plex Serif',serif;font-size:22px;margin:0 0 4px;letter-spacing:-0.01em;}
  .meta{font-family:'IBM Plex Mono',monospace;font-size:11px;color:#64748B;margin-bottom:12px;}
  .header-strip{display:flex;align-items:baseline;gap:12px;padding-bottom:12px;border-bottom:1px solid #E2E8F0;flex-wrap:wrap;}
  .header-strip .rank{font-family:'IBM Plex Mono',monospace;font-size:11px;color:#0C447C;font-weight:600;}
  .header-strip .post{margin-left:auto;font-family:'IBM Plex Serif',serif;font-size:28px;color:#0C447C;}
  .post .small{font-size:12px;}
  .post .label{font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:#64748B;display:block;text-align:right;}
  .section{margin-top:18px;}
  .section .title{font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.15em;color:#0C447C;margin-bottom:6px;}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .stat{padding:8px 10px;background:#F1F5F9;border-radius:4px;}
  .stat .l{font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:#64748B;}
  .stat .v{font-family:'IBM Plex Mono',monospace;font-size:14px;color:#0A1628;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  table th{text-align:left;padding:6px 8px;border-bottom:1px solid #CBD5E1;font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:#64748B;background:#F8FAFC;}
  table td{padding:6px 8px;border-bottom:1px solid #E2E8F0;}
  table .right{text-align:right;}
  .mono{font-family:'IBM Plex Mono',monospace;}
  .muted{color:#64748B;}
  .chip{display:inline-block;padding:1px 6px;border-radius:3px;font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;}
  .chip.teal{background:#E6F5F2;color:#0E8574;}
  .chip.amber{background:#FEF3C7;color:#B45309;}
  .chip.blue{background:#E0F2FE;color:#075985;}
  .calc{font-family:'IBM Plex Mono',monospace;font-size:13px;background:#EFF4FB;padding:12px;border-radius:4px;line-height:1.8;border-left:3px solid #0C447C;}
  .calc .op{color:#64748B;}
  .calc .res{color:#0C447C;font-weight:600;}
  ul.refs{font-size:11px;line-height:1.6;padding-left:18px;margin:0;color:#334155;}
  .footer{margin-top:18px;padding-top:12px;border-top:1px solid #E2E8F0;font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.15em;color:#B45309;}
  .footer .disc{color:#64748B;text-transform:none;letter-spacing:0;font-family:'IBM Plex Sans KR',sans-serif;font-size:10px;margin-top:3px;}
</style></head><body>
  <div class="card">
    <div class="header-strip">
      <span class="rank">감별진단 #${rank}</span>
      <h1>${dx.name}</h1>
      <span style="display:flex;gap:6px;align-items:baseline;">${flagBadges}</span>
      <div class="post">
        <span class="label">통합 스코어</span>
        ${(dx.prob * 100).toFixed(0)}<span class="small">%</span>
      </div>
    </div>
    <div class="meta">환자 · ${patient.name} · ${sex} · ${patient.age}세 · ${patient.mrn} · Phase 3·4 다중모달 가중 스코어링</div>

    <div class="section">
      <div class="title">1. 다중모달 가중 스코어 (Phase 3 · S/L/R/M 4축)</div>
      <table>
        <thead><tr><th>축</th><th>Modality</th><th class="right">매칭</th><th class="right">가중치</th><th class="right">기여</th></tr></thead>
        <tbody>${axisRows}</tbody>
      </table>
      <div class="muted mono" style="font-size:10px;margin-top:6px;">
        각 modality 매칭 점수 × disease profile 가중치 → 합산. (Likelihood Ratio 아님 — 가중 스코어링)
      </div>
    </div>

    <div class="section">
      <div class="title">2. 증상 (HPO) 매칭 — S축</div>
      <table>
        <thead><tr><th>HPO ID</th><th>증상</th><th>관찰</th></tr></thead>
        <tbody>${hpoRows}</tbody>
      </table>
    </div>

    <div class="section">
      <div class="title">3. Phase 4 · LLM 재검증 (Bedrock Claude)</div>
      <div class="grid2">
        <div class="stat"><div class="l">LLM 신뢰도</div><div class="v">${ev.p4Confidence}</div></div>
        <div class="stat"><div class="l">Phase 3 top 동의</div><div class="v">${ev.p4Agree ? '동의' : '재검토 권고'}</div></div>
      </div>
    </div>

    <div class="section">
      <div class="title">4. 통합 스코어 계산</div>
      <div class="calc">
        통합 스코어 = Σ ( modality 매칭 <span class="op">×</span> 가중치 )<br/>
        = ${ev.axes.map(a => `${(a.score * a.weight * 100).toFixed(1)}`).join(' <span class="op">+</span> ')}<br/>
        ⇒ <span class="res">${(dx.prob * 100).toFixed(0)}%</span> · Phase 4 LLM rerank 반영
      </div>
    </div>

    <div class="section">
      <div class="title">5. 참고 문헌</div>
      <ul class="refs">${refList}</ul>
    </div>

    <div class="footer">
      ⚠ AI-Assisted · Final diagnosis requires physician review
      <div class="disc">본 계산 결과는 진단 보조용이며 최종 진단 및 치료 결정은 주치의의 임상적 판단에 따릅니다. [EU AI Act Art. 22]</div>
    </div>
  </div>
</body></html>`);
  w.document.close();
}

function openDxEvidencePopup(patient, dx, rank) {
  // 일반/기타 질환 → Phase 3·4 통합 스코어 popup (LR 용어 없음)
  // 희귀질환     → Phase 5 LIRICAL Likelihood Ratio popup
  if (!dx.rare) {
    openCommonDxEvidencePopup(patient, dx, rank);
    return;
  }
  const w = window.open('', `dx-${patient.mrn}-${rank}`, 'width=900,height=900,resizable=yes,scrollbars=yes');
  if (!w) {
    alert('팝업 차단을 해제해주세요.');
    return;
  }
  const ev = buildDxEvidence(patient, dx);
  const sex = patient.sex === 'M' ? '남' : '여';

  const hpoRows = ev.hpoTerms.map(t => `
    <tr class="${t.state === 'observed' ? '' : 'muted-row'}">
      <td class="mono">${t.id}</td>
      <td>${t.label}</td>
      <td>${t.state === 'observed'
        ? '<span class="chip teal">관찰</span>'
        : '<span class="chip muted">미관찰</span>'}</td>
      <td class="right mono"><b>${t.lr.toFixed(1)}</b></td>
      <td class="right mono muted">log₁₀ ${Math.log10(t.lr).toFixed(2)}</td>
    </tr>`).join('');

  const refList = ev.refs.map(r => `<li>${r}</li>`).join('');

  const flagBadges = [
    dx.dontMiss ? '<span class="chip amber">Don\'t miss</span>' : '',
    dx.rare     ? '<span class="chip rare">희귀질환</span>' : '',
    dx.orpha    ? `<span class="mono small muted">${dx.orpha}</span>` : '',
  ].filter(Boolean).join(' ');

  w.document.write(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${dx.name} · 계산 근거</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@500&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
<style>
  html, body { margin: 0; padding: 0; }
  body { background: #F8FAFC; font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif; color: #0A1628; padding: 24px; -webkit-font-smoothing: antialiased; }
  .card { background: white; max-width: 760px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 6px; padding: 28px; }
  h1 { font-family: 'IBM Plex Serif', serif; font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .meta { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #64748B; margin-bottom: 12px; }
  .header-strip { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid #E2E8F0; flex-wrap: wrap; }
  .header-strip .rank { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #0C447C; font-weight: 600; }
  .header-strip .post {
    margin-left: auto; font-family: 'IBM Plex Serif', serif; font-size: 28px; color: #0C447C;
  }
  .post .small { font-size: 12px; }
  .post .label { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; display: block; text-align: right; }
  .section { margin-top: 18px; }
  .section .title { font-family: 'IBM Plex Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: #0C447C; margin-bottom: 6px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .stat { padding: 8px 10px; background: #F1F5F9; border-radius: 4px; }
  .stat .l { font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; }
  .stat .v { font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #0A1628; }
  .stat.warn { background: #FEF3C7; }
  .stat.warn .v { color: #B45309; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #CBD5E1; font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748B; background: #F8FAFC; }
  table td { padding: 6px 8px; border-bottom: 1px solid #E2E8F0; }
  table .right { text-align: right; }
  .mono { font-family: 'IBM Plex Mono', monospace; }
  .muted { color: #64748B; }
  .small { font-size: 10px; }
  .chip { display: inline-block; padding: 1px 6px; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; }
  .chip.teal  { background: #E6F5F2; color: #0E8574; }
  .chip.amber { background: #FEF3C7; color: #B45309; }
  .chip.rare  { background: #F3E8FF; color: #6B21A8; }
  .chip.muted { background: #F1F5F9; color: #94A3B8; }
  tr.muted-row td:nth-child(2) { color: #94A3B8; }
  .bayes {
    font-family: 'IBM Plex Mono', monospace; font-size: 13px;
    background: #EFF4FB; padding: 12px; border-radius: 4px; line-height: 1.8;
    border-left: 3px solid #0C447C;
  }
  .bayes .op { color: #64748B; }
  .bayes .res { color: #0C447C; font-weight: 600; }
  ul.refs { font-size: 11px; line-height: 1.6; padding-left: 18px; margin: 0; color: #334155; }
  .footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-family: 'IBM Plex Mono', monospace; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: #B45309; }
  .footer .disc { color: #64748B; text-transform: none; letter-spacing: 0; font-family: 'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif; font-size: 10px; margin-top: 3px; }
</style>
</head>
<body>
  <div class="card">
    <div class="header-strip">
      <span class="rank">Top #${rank}</span>
      <h1>${dx.name}</h1>
      <span style="display:flex;gap:6px;align-items:baseline;">${flagBadges}</span>
      <div class="post">
        <span class="label">Posterior probability</span>
        ${(ev.postProb * 100).toFixed(0)}<span class="small">%</span>
      </div>
    </div>
    <div class="meta">환자 · ${patient.name} · ${sex} · ${patient.age}세 · ${patient.mrn}</div>

    <div class="section">
      <div class="title">1. Prior · 모집단 prevalence</div>
      <div class="grid2">
        <div class="stat"><div class="l">Prevalence</div><div class="v">${ev.prevalence}</div></div>
        <div class="stat"><div class="l">Prior probability</div><div class="v">${(ev.priorProb * 100).toFixed(3)}%</div></div>
      </div>
    </div>

    <div class="section">
      <div class="title">2. HPO 기반 Likelihood Ratio (Robinson 2020)</div>
      <table>
        <thead><tr><th>HPO ID</th><th>증상</th><th>관찰</th><th class="right">LR+</th><th class="right">log₁₀ LR</th></tr></thead>
        <tbody>${hpoRows}</tbody>
      </table>
      <div class="muted small mono" style="margin-top:6px;">관찰된 ${ev.observedCount}개 term의 LR을 곱하여 종합 ⇒ ∏LR<sub>HPO</sub> = <b>${ev.combinedHpoLr.toFixed(2)}</b></div>
    </div>

    <div class="section">
      <div class="title">3. CXR DenseNet-121 기여</div>
      <div class="grid2">
        <div class="stat"><div class="l">Model output (CXR)</div><div class="v">${(ev.cxrScore * 100).toFixed(1)}%</div></div>
        <div class="stat"><div class="l">변환 LR<sub>CXR</sub></div><div class="v">${ev.cxrLr.toFixed(2)}</div></div>
      </div>
    </div>

    <div class="section">
      <div class="title">4. Bayes 종합 계산</div>
      <div class="bayes">
        Posterior odds = Prior odds <span class="op">×</span> ∏LR<sub>HPO</sub> <span class="op">×</span> LR<sub>CXR</sub><br/>
        = ${ev.priorOdds.toExponential(2)} <span class="op">×</span> ${ev.combinedHpoLr.toFixed(2)} <span class="op">×</span> ${ev.cxrLr.toFixed(2)}<br/>
        = <span class="res">${ev.postOdds.toFixed(3)}</span><br/>
        ⇒ Posterior probability = odds / (1 + odds) = <span class="res">${(ev.postProb * 100).toFixed(1)}%</span>
      </div>
    </div>

    <div class="section">
      <div class="title">5. 참고 문헌</div>
      <ul class="refs">${refList}</ul>
    </div>

    <div class="footer">
      ⚠ AI-Assisted · Final diagnosis requires physician review
      <div class="disc">본 계산 결과는 진단 보조용이며 최종 진단 및 치료 결정은 주치의의 임상적 판단에 따릅니다. [EU AI Act Art. 22]</div>
    </div>
  </div>
</body>
</html>`);
  w.document.close();
}

/* ============================================================
   SCREEN · SETTINGS
   ============================================================ */
function SettingsScreen({ doctor, onLogout, onNavigate, onOpenPatient, onOpenAnnouncement }) {
  const [prefs, setPrefs] = useState({
    notif:    { unread: true,  dontMiss: true, daily: false, sound: false },
    ai:       { defaultCxrView: 'original', topN: 3, lrBar: true, rareFirst: true, explanation: true },
    display:  { lang: 'ko', density: 'compact', theme: 'light', zoom: 80 },
    worklist: { defaultSection: 'today', autoRefresh: 30, sortBy: 'time' },
  });

  const setSlice = (key, val) => setPrefs(p => ({ ...p, [key]: { ...p[key], ...val } }));

  // 외래 데이터 수신 시각 — 의사 계정(Cognito custom attribute)에 저장. 기본 08:00.
  const [worklistTime, setWorklistTime] = useState(doctor?.worklistTime || '08:00');
  const [timeSaveState, setTimeSaveState] = useState('idle'); // idle | saving | saved | error
  async function handleWorklistTime(t) {
    setWorklistTime(t);
    setTimeSaveState('saving');
    try {
      await saveWorklistTime(t);
      setTimeSaveState('saved');
      setTimeout(() => setTimeSaveState('idle'), 2000);
    } catch (e) {
      console.warn('[worklist-time save]', e);
      setTimeSaveState('error');
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rl-bg-2)' }}>
      <TopBar doctor={doctor} onLogout={onLogout} activeScreen="settings" onNavigate={onNavigate} onOpenPatient={onOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-8 py-6">
        {/* Header */}
        <div className="flex items-baseline gap-4 mb-5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-ink-3)' }}>
              Settings · v0.1.0
            </div>
            <h1 className="font-serif text-3xl" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
              설정
            </h1>
          </div>
          <button
            onClick={() => onNavigate('worklist')}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded text-xs hairline-strong hover:bg-slate-50"
            style={{ color: 'var(--rl-ink-2)' }}
          >
            <ChevronLeft size={12} /> 환자 목록으로
          </button>
        </div>

        {/* 8 cards in 3-column grid */}
        <div className="grid grid-cols-3 gap-3">
          <AccountCard       doctor={doctor} onLogout={onLogout} />
          <NotificationCard  prefs={prefs.notif}    set={(v) => setSlice('notif', v)} />
          <AICard            prefs={prefs.ai}       set={(v) => setSlice('ai', v)} />
          <DisplayCard       prefs={prefs.display}  set={(v) => setSlice('display', v)} />
          <WorklistPrefCard  prefs={prefs.worklist} set={(v) => setSlice('worklist', v)}
            worklistTime={worklistTime} onWorklistTime={handleWorklistTime} timeSaveState={timeSaveState} />
          <SecurityCard      onLogout={onLogout} />
          <SystemCard        onNavigate={onNavigate} />
          <HelpCard />
        </div>
      </main>
    </div>
  );
}

/* ----- Setting card primitives ----- */
function SettingRow({ icon, label, sub, children }) {
  return (
    <div
      className="flex items-center gap-2.5 py-2"
      style={{ borderBottom: '1px solid var(--rl-border-soft)' }}
    >
      {icon && <span style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }}>{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-xs" style={{ color: 'var(--rl-ink)' }}>{label}</div>
        {sub && <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--rl-ink-3)' }}>{sub}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="relative rounded-full transition"
      style={{
        width: 30, height: 16,
        background: value ? 'var(--rl-primary)' : 'var(--rl-border)',
      }}
    >
      <span
        className="absolute top-0.5 bg-white rounded-full transition shadow"
        style={{ width: 12, height: 12, left: value ? 16 : 2 }}
      />
    </button>
  );
}

function SettingSelect({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        const opt = options.find(o => String(o.k) === v);
        onChange(opt ? opt.k : v);
      }}
      className="font-mono text-[11px] hairline-strong rounded px-2 py-1 outline-none focus:border-[color:var(--rl-primary)]"
      style={{ background: 'white', color: 'var(--rl-ink)' }}
    >
      {options.map(o => <option key={String(o.k)} value={String(o.k)}>{o.label}</option>)}
    </select>
  );
}

function ReadValue({ children, mono }) {
  return (
    <span
      className={`text-xs ${mono ? 'font-mono' : ''}`}
      style={{ color: 'var(--rl-ink-2)' }}
    >
      {children}
    </span>
  );
}

/* ----- 8 setting cards ----- */
function AccountCard({ doctor, onLogout }) {
  return (
    <Panel title="계정" mono="Account" right={<User size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      <SettingRow label="이름">           <ReadValue>{doctor.name}</ReadValue></SettingRow>
      <SettingRow label="직급">           <ReadValue>{doctor.role}</ReadValue></SettingRow>
      <SettingRow label="소속">           <ReadValue>{doctor.institution}</ReadValue></SettingRow>
      <SettingRow label="진료과">         <ReadValue>{doctor.department}</ReadValue></SettingRow>
      <SettingRow label="의사 ID">        <ReadValue mono>{doctor.id}</ReadValue></SettingRow>
      <SettingRow label="면허 번호">      <ReadValue mono>#12345</ReadValue></SettingRow>
      <button
        onClick={onLogout}
        className="w-full py-2 rounded text-xs font-medium hairline-strong flex items-center justify-center gap-1.5 mt-2 hover:bg-slate-50"
        style={{ color: 'var(--rl-critical)', borderColor: 'var(--rl-critical)' }}
      >
        <LogOut size={12} /> 로그아웃
      </button>
    </Panel>
  );
}

function NotificationCard({ prefs, set }) {
  return (
    <Panel title="알림" mono="Notifications" right={<Bell size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      <SettingRow icon={<Inbox size={13} />}     label="미확인 결과 알림"    sub="결과 도착 시 배지 표시"><Toggle value={prefs.unread}   onChange={(v) => set({ unread: v })} /></SettingRow>
      <SettingRow icon={<AlertTriangle size={13} />} label="Don't miss 긴급" sub="희귀·중증 의심 시 우선 알림"><Toggle value={prefs.dontMiss} onChange={(v) => set({ dontMiss: v })} /></SettingRow>
      <SettingRow icon={<Volume2 size={13} />}    label="알림음"             sub="긴급 알림에 한정"><Toggle value={prefs.sound}    onChange={(v) => set({ sound: v })} /></SettingRow>
      <SettingRow icon={<Mail size={13} />}        label="일일 다이제스트"    sub="매일 오전 7시 이메일"><Toggle value={prefs.daily}    onChange={(v) => set({ daily: v })} /></SettingRow>
    </Panel>
  );
}

function AICard({ prefs, set }) {
  return (
    <Panel title="AI 모델 · 표시" mono="AI Preferences" right={<Microscope size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      <SettingRow label="디폴트 CXR 뷰">
        <SettingSelect
          value={prefs.defaultCxrView}
          onChange={(v) => set({ defaultCxrView: v })}
          options={[
            { k: 'original', label: '원본' },
            { k: 'heatmap',  label: 'Heatmap' },
            { k: 'compare',  label: '비교' },
          ]}
        />
      </SettingRow>
      <SettingRow label="감별진단 표시 개수">
        <SettingSelect
          value={prefs.topN}
          onChange={(v) => set({ topN: Number(v) })}
          options={[
            { k: 3,  label: 'Top 3' },
            { k: 5,  label: 'Top 5' },
            { k: 10, label: 'Top 10' },
          ]}
        />
      </SettingRow>
      <SettingRow label="LR 막대 표시" sub="Robinson 2020 Fig.2 형식"><Toggle value={prefs.lrBar}       onChange={(v) => set({ lrBar: v })} /></SettingRow>
      <SettingRow label="희귀질환 우선 정렬"><Toggle value={prefs.rareFirst}   onChange={(v) => set({ rareFirst: v })} /></SettingRow>
      <SettingRow label="설명가능성 기본 ON" sub="Heatmap·LR 자동 표시 (Neri 2023)"><Toggle value={prefs.explanation} onChange={(v) => set({ explanation: v })} /></SettingRow>
    </Panel>
  );
}

function DisplayCard({ prefs, set }) {
  return (
    <Panel title="표시 · 언어" mono="Display" right={<Palette size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      <SettingRow icon={<Languages size={13} />} label="언어">
        <SettingSelect
          value={prefs.lang}
          onChange={(v) => set({ lang: v })}
          options={[
            { k: 'ko', label: '한국어' },
            { k: 'en', label: 'English (W4)' },
          ]}
        />
      </SettingRow>
      <SettingRow label="글자 / 화면 비율">
        <SettingSelect
          value={prefs.zoom}
          onChange={(v) => set({ zoom: Number(v) })}
          options={[
            { k: 75,  label: '75%' },
            { k: 80,  label: '80% (현재)' },
            { k: 90,  label: '90%' },
            { k: 100, label: '100%' },
          ]}
        />
      </SettingRow>
      <SettingRow label="정보 밀도">
        <SettingSelect
          value={prefs.density}
          onChange={(v) => set({ density: v })}
          options={[
            { k: 'compact', label: '컴팩트' },
            { k: 'normal',  label: '일반' },
          ]}
        />
      </SettingRow>
      <SettingRow label="테마">
        <SettingSelect
          value={prefs.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { k: 'light', label: 'Light' },
            { k: 'dark',  label: 'Dark (W4)' },
          ]}
        />
      </SettingRow>
    </Panel>
  );
}

/* 외래 수신 시각 — 세로 chevron stepper (시 / 분) */
function TimeUnit({ value, onChange, step = 1, max }) {
  const pad = (n) => String(n).padStart(2, '0');
  const up   = () => onChange((value + step) % (max + 1));
  const down = () => onChange((value - step + max + 1) % (max + 1));
  const btn = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 32, height: 16, border: 'none', background: 'transparent',
    cursor: 'pointer', color: 'var(--rl-ink-3)', padding: 0,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <button style={btn} onClick={up} title="올림"
        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--rl-primary)')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--rl-ink-3)')}>
        <ChevronUp size={13} />
      </button>
      <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 19, fontWeight: 600,
                     color: 'var(--rl-primary-dark)', lineHeight: 1, letterSpacing: '0.02em' }}>
        {pad(value)}
      </span>
      <button style={btn} onClick={down} title="내림"
        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--rl-primary)')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--rl-ink-3)')}>
        <ChevronDown size={13} />
      </button>
    </div>
  );
}

function WorklistPrefCard({ prefs, set, worklistTime = '08:00', onWorklistTime, timeSaveState = 'idle' }) {
  const saveLabel = timeSaveState === 'saving' ? '저장 중…'
    : timeSaveState === 'saved' ? '저장됨'
    : timeSaveState === 'error' ? '저장 실패' : '';
  const saveColor = timeSaveState === 'error' ? 'var(--rl-critical)'
    : timeSaveState === 'saved' ? 'var(--rl-teal)' : 'var(--rl-ink-3)';
  const [hhRaw, mmRaw] = String(worklistTime || '08:00').split(':');
  const hh = Math.min(23, parseInt(hhRaw, 10) || 0);
  const mm = Math.min(59, parseInt(mmRaw, 10) || 0);
  const cur = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const emit = (h, m) =>
    onWorklistTime && onWorklistTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  const PRESETS = ['07:00', '07:30', '08:00', '08:30', '09:00'];

  return (
    <Panel title="환자 목록" mono="Worklist" right={<ListFilter size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      {/* 외래 데이터 수신 시각 — chevron stepper + 프리셋 칩 */}
      <div style={{ padding: '6px 0 10px', borderBottom: '1px solid var(--rl-border-soft)' }}>
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-[11px] font-medium" style={{ color: 'var(--rl-ink)' }}>외래 데이터 수신 시각</div>
            <div className="text-[9px]" style={{ color: 'var(--rl-ink-3)', marginTop: 1 }}>
              당일 외래 환자 데이터 일괄 수신 · 의사 계정에 저장
            </div>
          </div>
          {saveLabel && (
            <span className="font-mono text-[9px] flex items-center gap-1" style={{ color: saveColor }}>
              {timeSaveState === 'saving' ? <Loader2 size={9} className="spin" />
               : timeSaveState === 'saved' ? <CheckCircle2 size={9} /> : null}
              {saveLabel}
            </span>
          )}
        </div>
        <div className="flex items-center" style={{ gap: 10 }}>
          <div className="flex items-center hairline-strong rounded"
               style={{ background: 'white', padding: '3px 8px', gap: 4 }}>
            <TimeUnit value={hh} max={23} step={1}  onChange={(v) => emit(v, mm)} />
            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 17, fontWeight: 600,
                           color: 'var(--rl-ink-3)', paddingBottom: 1 }}>:</span>
            <TimeUnit value={mm} max={59} step={30} onChange={(v) => emit(hh, v)} />
          </div>
          <div className="flex flex-col" style={{ gap: 3 }}>
            <div className="font-mono text-[8px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>빠른 선택</div>
            <div className="flex" style={{ gap: 3 }}>
              {PRESETS.map((p) => {
                const active = p === cur;
                return (
                  <button key={p}
                    onClick={() => { const [h, m] = p.split(':'); emit(+h, +m); }}
                    className="font-mono transition hover:opacity-90"
                    style={{
                      fontSize: 9.5, padding: '3px 7px', borderRadius: 11, cursor: 'pointer',
                      border: '1px solid ' + (active ? 'var(--rl-primary)' : 'var(--rl-border)'),
                      background: active ? 'var(--rl-primary)' : 'white',
                      color: active ? 'white' : 'var(--rl-ink-2)',
                    }}>
                    {p}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <SettingRow label="기본 진입 섹션">
        <SettingSelect
          value={prefs.defaultSection}
          onChange={(v) => set({ defaultSection: v })}
          options={[
            { k: 'today',  label: '당일 외래' },
            { k: 'unread', label: '미확인 결과' },
            { k: 'search', label: '환자 검색' },
          ]}
        />
      </SettingRow>
      <SettingRow label="자동 새로고침">
        <SettingSelect
          value={prefs.autoRefresh}
          onChange={(v) => set({ autoRefresh: Number(v) })}
          options={[
            { k: 0,   label: '꺼짐' },
            { k: 30,  label: '30초' },
            { k: 60,  label: '1분' },
            { k: 300, label: '5분' },
          ]}
        />
      </SettingRow>
      <SettingRow label="기본 정렬">
        <SettingSelect
          value={prefs.sortBy}
          onChange={(v) => set({ sortBy: v })}
          options={[
            { k: 'time',     label: '예약 시간' },
            { k: 'priority', label: '우선순위' },
            { k: 'arrival',  label: '도착 순' },
          ]}
        />
      </SettingRow>
    </Panel>
  );
}

function SecurityCard({ onLogout }) {
  const session = loadSession();
  const remaining = session.expiresAt ? Math.max(0, session.expiresAt - Date.now()) : 0;
  const minutes = Math.floor(remaining / 60000);
  return (
    <Panel title="보안 · 세션" mono="Security" right={<Shield size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      <SettingRow label="세션 저장 위치"><ReadValue mono>sessionStorage</ReadValue></SettingRow>
      <SettingRow label="세션 TTL"><ReadValue mono>1 hour</ReadValue></SettingRow>
      <SettingRow icon={<Clock size={13} />} label="세션 잔여 시간">
        <span className="font-mono text-xs" style={{ color: minutes < 10 ? 'var(--rl-amber)' : 'var(--rl-teal)' }}>
          {minutes}분
        </span>
      </SettingRow>
      <SettingRow label="환자 정보 저장" sub="개인정보보호법 · HIPAA"><span className="chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>저장 안함</span></SettingRow>
      <SettingRow icon={<KeyRound size={13} />} label="2단계 인증" sub="AWS Cognito 연동 W3+"><span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-4)' }}>예정</span></SettingRow>
      <button
        onClick={onLogout}
        className="w-full py-2 rounded text-xs font-medium flex items-center justify-center gap-1.5 mt-2"
        style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}
      >
        <Clock size={12} /> 세션 즉시 만료
      </button>
    </Panel>
  );
}

function SystemCard({ onNavigate }) {
  const sysCount = MOCK_NOTIFICATION_HISTORY.filter(n => n.category === 'system').length;
  return (
    <Panel title="시스템 정보" mono="System" right={<Database size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      <SettingRow label="앱 버전">           <ReadValue mono>v0.1.0 · build 2026-04-23</ReadValue></SettingRow>
      <SettingRow label="DenseNet-121">      <ReadValue mono>v2.3.1 · 2026-03-15 retrain</ReadValue></SettingRow>
      <SettingRow label="HPO-LR 엔진">       <ReadValue mono>v1.4 · LIRICAL ported</ReadValue></SettingRow>
      <SettingRow label="HPO 데이터베이스">  <ReadValue mono>2026-03-01 release</ReadValue></SettingRow>
      <SettingRow label="Orphadata">         <ReadValue mono>2026-Q1 · 9,872 dx</ReadValue></SettingRow>
      <SettingRow label="FHIR 서버">         <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--rl-teal)' }} /><span className="font-mono text-[10px]" style={{ color: 'var(--rl-teal)' }}>SMART Health IT</span></span></SettingRow>
      <SettingRow label="SageMaker Endpoint"><span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>us-east-1 · pre-2-2team</span></SettingRow>
      <button
        onClick={() => onNavigate && onNavigate('announcement')}
        className="w-full py-2 rounded text-xs font-medium hairline-strong flex items-center justify-center gap-1.5 mt-2 hover:bg-slate-50 transition"
        style={{ color: 'var(--rl-primary)', borderColor: 'var(--rl-primary)' }}
        title="시스템 공지 페이지로 이동"
      >
        <Megaphone size={12} /> 시스템 공지 보기
        <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>· {sysCount}건</span>
        <ArrowUpRight size={11} />
      </button>
      <button
        onClick={() => onNavigate && onNavigate('designsystem')}
        className="w-full py-2 rounded text-xs font-medium hairline-strong flex items-center justify-center gap-1.5 mt-2 hover:bg-slate-50 transition"
        style={{ color: 'var(--rl-primary)', borderColor: 'var(--rl-primary)' }}
        title="디자인 시스템 showcase 로 이동"
      >
        <Palette size={12} /> 디자인 시스템
        <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>· v0.1</span>
        <ArrowUpRight size={11} />
      </button>
    </Panel>
  );
}

function HelpCard() {
  const links = [
    { label: '사용 가이드',          sub: '의사용 매뉴얼 · PDF' },
    { label: '키보드 단축키',        sub: '환자 검색 / 새로고침 / 로그아웃' },
    { label: '변경 내역',            sub: 'CHANGELOG · 빌드별 기능 추가' },
    { label: '개인정보 처리방침',    sub: '환자 정보 저장 정책' },
    { label: '오픈소스 라이선스',    sub: 'lucide-react · React · Tailwind …' },
  ];
  return (
    <Panel title="도움말 · 정보" mono="Help" right={<HelpCircle size={12} style={{ color: 'var(--rl-ink-3)' }} />}>
      {links.map(l => (
        <SettingRow key={l.label} label={l.label} sub={l.sub}>
          <ChevronRight size={12} style={{ color: 'var(--rl-ink-3)' }} />
        </SettingRow>
      ))}
      <div className="mt-3 pt-3 text-[10px]" style={{ borderTop: '1px solid var(--rl-border-soft)', color: 'var(--rl-ink-3)' }}>
        <div className="font-mono uppercase tracking-widest mb-1" style={{ color: 'var(--rl-primary)' }}>SKKU AWS SAY 2기 · 2팀</div>
        박성수 (Frontend) · 배기태 · 허태웅 (Model · AWS) · 권미라 · 양희인 (MIMIC · KB) · 이희찬 (멘토)
      </div>
    </Panel>
  );
}

/* ============================================================
   SCREEN · KNOWLEDGE BASE (희귀질환 지식베이스)
   ------------------------------------------------------------
   내부 DB(/mock_fhir/knowledge/rare_diseases.json) 기반 희귀질환 레퍼런스.
   외부 검색은 직접 API 호출 없이 공식 레퍼런스(Orphanet·PubMed·OMIM·
   GARD·KDCA 희귀질환 헬프라인)로 링크 연계만 제공한다.
   참조: 사용자 요구 — "우리 db기반으로 해서 외부 api까지 연계해주는정도"
   ============================================================ */

/* 질환 → 외부 공식 레퍼런스 URL (직접 호출 아님, 새 탭 링크). */
function externalRefs(d) {
  const q = encodeURIComponent(d.name_en);
  const refs = [
    { key: 'orphanet', label: 'Orphanet', sub: d.orpha ? `ORPHA:${d.orpha}` : '질환 상세',
      url: d.orpha ? `https://www.orpha.net/en/disease/detail/${d.orpha}` : `https://www.orpha.net/en/disease/search?query=${q}` },
    { key: 'pubmed', label: 'PubMed', sub: '최신 문헌 검색',
      url: `https://pubmed.ncbi.nlm.nih.gov/?term=${q}` },
    { key: 'gard', label: 'GARD (NIH)', sub: '환자·임상 요약',
      url: `https://rarediseases.info.nih.gov/diseases/search?query=${q}` },
    { key: 'kdca', label: 'KDCA 희귀질환 헬프라인', sub: '국내 산정특례·지원',
      url: 'https://helpline.kdca.go.kr/cdchelp/index.do' },
  ];
  if (d.omim) {
    refs.splice(2, 0, { key: 'omim', label: 'OMIM', sub: `#${d.omim} 유전 정보`,
      url: `https://www.omim.org/entry/${d.omim}` });
  }
  return refs;
}

function KnowledgeBaseScreen({ doctor, onLogout, onNavigate, onOpenPatient, onOpenAnnouncement }) {
  const [kb, setKb] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all');
  const [selId, setSelId] = useState(null);

  useEffect(() => {
    fetch('/mock_fhir/knowledge/rare_diseases.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { setKb(j); setSelId(j.diseases[0]?.id || null); })
      .catch(e => setError(e.message));
  }, []);

  const diseases = kb?.diseases || [];
  const categories = ['all', ...Array.from(new Set(diseases.map(d => d.category)))];

  const filtered = diseases.filter(d => {
    if (cat !== 'all' && d.category !== cat) return false;
    if (query) {
      const s = query.toLowerCase();
      const hay = [
        d.name_kr, d.name_en, d.abbr, d.orpha && `orpha:${d.orpha}`, d.icd10,
        ...(d.hpo || []).map(h => h.code + ' ' + h.label),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  const selected = diseases.find(d => d.id === selId) || filtered[0] || null;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rl-bg-2)' }}>
      <TopBar doctor={doctor} onLogout={onLogout} activeScreen="knowledge" onNavigate={onNavigate} onOpenPatient={onOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-8 py-6">
        {/* Header */}
        <div className="flex items-baseline gap-3 mb-1">
          <h1 className="font-serif text-2xl" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
            희귀질환 지식베이스
          </h1>
          <div className="font-mono text-[11px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
            Rare Disease Knowledge Base
          </div>
        </div>
        <div className="flex items-center gap-2 mb-4 text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>
          <Database size={12} style={{ color: 'var(--rl-primary)' }} />
          <span>내부 DB 기반 · {kb ? kb.source : '로드 중'}</span>
          {kb && <span className="font-mono">· 갱신 {kb.updated}</span>}
        </div>

        {error && (
          <div className="hairline rounded bg-white p-6 text-sm" style={{ color: 'var(--rl-critical)' }}>
            <AlertTriangle size={16} className="inline mr-2" />지식베이스 로드 실패: {error}
          </div>
        )}
        {!kb && !error && (
          <div className="hairline rounded bg-white p-12 text-center text-sm flex items-center justify-center gap-2" style={{ color: 'var(--rl-primary)' }}>
            <Loader2 size={16} className="spin" /> 지식베이스 로드 중…
          </div>
        )}

        {kb && (
          <>
            {/* 검색 + 카테고리 필터 */}
            <div className="hairline rounded bg-white p-2 mb-3 flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--rl-ink-3)' }} />
                <input
                  placeholder="질환명 · 영문명 · ORPHA · ICD-10 · HPO"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="pl-8 pr-3 py-1.5 rounded text-xs hairline-strong outline-none w-72 focus:border-[color:var(--rl-primary)]"
                />
              </div>
              <span className="self-stretch w-px mx-1" style={{ background: 'var(--rl-border-soft)' }} />
              {categories.map(c => (
                <button
                  key={c}
                  onClick={() => setCat(c)}
                  className="px-2.5 py-1.5 rounded text-xs font-medium transition"
                  style={{
                    background: cat === c ? 'var(--rl-primary)' : 'transparent',
                    color: cat === c ? 'white' : 'var(--rl-ink-2)',
                  }}
                >
                  {c === 'all' ? `전체 ${diseases.length}` : c}
                </button>
              ))}
              <span className="ml-auto font-mono text-[10px] pr-1" style={{ color: 'var(--rl-ink-3)' }}>
                {filtered.length} / {diseases.length} 질환
              </span>
            </div>

            {/* Master-detail */}
            <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)' }}>
              {/* 좌 — 질환 목록 */}
              <div className="hairline rounded bg-white overflow-hidden" style={{ alignSelf: 'start' }}>
                {filtered.length === 0 && (
                  <div className="p-8 text-center text-sm" style={{ color: 'var(--rl-ink-3)' }}>
                    검색 결과가 없습니다.
                  </div>
                )}
                {filtered.map((d, i) => {
                  const on = selected && d.id === selected.id;
                  return (
                    <button
                      key={d.id}
                      onClick={() => setSelId(d.id)}
                      className="w-full text-left px-3 py-2.5 transition"
                      style={{
                        background: on ? 'var(--rl-primary-soft)' : 'white',
                        borderBottom: i === filtered.length - 1 ? 'none' : '1px solid var(--rl-border-soft)',
                        borderLeft: on ? '3px solid var(--rl-primary)' : '3px solid transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-sm font-medium truncate" style={{ color: 'var(--rl-ink)' }}>{d.name_kr}</span>
                        {d.abbr && <span className="font-mono text-[10px]" style={{ color: 'var(--rl-primary)' }}>{d.abbr}</span>}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--rl-ink-3)' }}>{d.name_en}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        {d.orpha && <span className="font-mono text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>ORPHA:{d.orpha}</span>}
                        <span className="font-mono text-[9px]" style={{ color: 'var(--rl-ink-3)' }}>{d.icd10}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* 우 — 질환 상세 */}
              {selected && <KbDetail d={selected} />}
            </div>

            {/* Disclaimer */}
            <div className="mt-4 px-4 py-2 text-[11px] flex items-start gap-2 rounded" style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)' }}>
              <AlertTriangle size={12} style={{ color: 'var(--rl-amber)', marginTop: 1, flexShrink: 0 }} />
              <div style={{ color: 'var(--rl-ink-2)' }}>
                <span className="font-medium" style={{ color: 'var(--rl-amber)' }}>본 지식베이스는 임상 의사결정 보조용 참고 자료입니다.</span>{' '}
                외부 레퍼런스는 직접 API 연동 없이 공식 출처로의 링크만 제공하며, 최종 진단·치료는 담당 의료진의 판단에 따릅니다.
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* 지식베이스 — 질환 상세 패널 */
function KbDetail({ d }) {
  const refs = externalRefs(d);
  const Meta = ({ label, value }) => (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest mb-0.5" style={{ color: 'var(--rl-ink-3)' }}>{label}</div>
      <div className="text-[12px]" style={{ color: 'var(--rl-ink)' }}>{value || '—'}</div>
    </div>
  );
  return (
    <div className="hairline rounded bg-white">
      {/* 헤더 */}
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-serif text-xl" style={{ color: 'var(--rl-ink)' }}>{d.name_kr}</span>
          {d.abbr && <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>{d.abbr}</span>}
          <span className="text-sm" style={{ color: 'var(--rl-ink-2)' }}>{d.name_en}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
            <Flame size={10} /> {d.category}
          </span>
          {d.orpha && <span className="font-mono text-[10px]" style={{ color: 'var(--rl-rare)' }}>ORPHA:{d.orpha}</span>}
          <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>ICD-10 {d.icd10}</span>
          {d.omim && <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>OMIM #{d.omim}</span>}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4">
        {/* 요약 */}
        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--rl-ink)' }}>{d.summary}</p>

        {/* 역학·발병 메타 */}
        <div className="grid grid-cols-3 gap-3 px-3 py-2.5 rounded" style={{ background: 'var(--rl-bg-3)' }}>
          <Meta label="유병률" value={d.prevalence} />
          <Meta label="발병 시기" value={d.onset} />
          <Meta label="유전 양식" value={d.inheritance} />
        </div>

        {/* 핵심 임상 소견 */}
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest mb-1.5" style={{ color: 'var(--rl-ink-3)' }}>핵심 임상 소견</div>
          <div className="flex flex-wrap gap-1.5">
            {(d.key_features || []).map((f, i) => (
              <span key={i} className="text-[11px] px-2 py-1 rounded hairline" style={{ background: 'white', color: 'var(--rl-ink-2)' }}>
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* HPO terms — 파이프라인 Phase 1 매핑 */}
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest mb-1.5 flex items-center gap-1" style={{ color: 'var(--rl-ink-3)' }}>
            <Microscope size={11} /> 대표 HPO 표현형 · Phase 1 매핑
          </div>
          <div className="flex flex-col gap-1">
            {(d.hpo || []).map(h => (
              <a
                key={h.code}
                href={`https://hpo.jax.org/browse/term/${h.code}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-[11px] px-2 py-1 rounded transition hover:bg-slate-50"
              >
                <span className="font-mono px-1.5 py-0.5 rounded" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>{h.code}</span>
                <span style={{ color: 'var(--rl-ink)' }}>{h.label}</span>
                <ArrowUpRight size={11} style={{ color: 'var(--rl-ink-3)', marginLeft: 'auto' }} />
              </a>
            ))}
          </div>
        </div>

        {/* 임상 가이드라인 */}
        <div className="flex items-start gap-2 px-3 py-2 rounded" style={{ background: 'var(--rl-teal-soft)' }}>
          <FileText size={13} style={{ color: 'var(--rl-teal)', marginTop: 1, flexShrink: 0 }} />
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--rl-teal)' }}>참조 가이드라인</div>
            <div className="text-[12px]" style={{ color: 'var(--rl-ink)' }}>{d.guideline}</div>
          </div>
        </div>

        {/* 외부 레퍼런스 링크 — 직접 API 호출 없음 */}
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest mb-1.5" style={{ color: 'var(--rl-ink-3)' }}>
            외부 공식 레퍼런스 연계
          </div>
          <div className="grid grid-cols-2 gap-2">
            {refs.map(r => (
              <a
                key={r.key}
                href={r.url}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded hairline-strong transition hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium" style={{ color: 'var(--rl-primary)' }}>{r.label}</div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--rl-ink-3)' }}>{r.sub}</div>
                </div>
                <ArrowUpRight size={13} style={{ color: 'var(--rl-primary)', flexShrink: 0 }} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   COMING SOON · Dashboard / Knowledge placeholder
   ============================================================ */
function ComingSoonScreen({ doctor, onLogout, onNavigate, screenKey, onOpenPatient, onOpenAnnouncement }) {
  const meta = {
    dashboard: {
      title: '분석 대시보드',
      mono: 'Analytics dashboard',
      icon: <BarChart3 size={32} style={{ color: 'var(--rl-primary)' }} />,
      desc: '병원 전체 KPI · 모델 성능 · 진단 트렌드 · 의사 동의율 (audit)',
      milestone: 'W4 · 5/11 ~ 5/17 구현 예정',
    },
    knowledge: {
      title: '지식 베이스',
      mono: 'Knowledge base',
      icon: <BookOpen size={32} style={{ color: 'var(--rl-primary)' }} />,
      desc: 'HPO term 검색 · Orphadata 참조 · 폐질환 임상 가이드라인 (Raghu 2022 · Travis 2008)',
      milestone: 'W4 · 5/11 ~ 5/17 구현 예정',
    },
  }[screenKey];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rl-bg-2)' }}>
      <TopBar doctor={doctor} onLogout={onLogout} activeScreen={screenKey} onNavigate={onNavigate} onOpenPatient={onOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-8 py-6">
        <div className="hairline rounded bg-white p-12 text-center fade-in">
          <div className="inline-block mb-3">{meta.icon}</div>
          <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-ink-3)' }}>
            {meta.mono}
          </div>
          <div className="font-serif text-2xl mb-2" style={{ color: 'var(--rl-ink)' }}>{meta.title}</div>
          <div className="text-sm mb-3" style={{ color: 'var(--rl-ink-3)' }}>{meta.desc}</div>
          <div className="font-mono text-[11px] uppercase tracking-widest" style={{ color: 'var(--rl-amber)' }}>
            {meta.milestone}
          </div>
          <button
            onClick={() => onNavigate('worklist')}
            className="mt-6 inline-flex items-center gap-1.5 px-4 py-2 rounded text-xs font-medium hairline-strong hover:bg-slate-50"
            style={{ color: 'var(--rl-primary)' }}
          >
            <ChevronLeft size={12} /> 환자 목록으로
          </button>
        </div>
      </main>
    </div>
  );
}

/* ============================================================
   SCREEN · ANNOUNCEMENT (시스템 공지)
   ============================================================ */
function AnnouncementScreen({ doctor, onLogout, onNavigate, onOpenPatient, onOpenAnnouncement, initialNotif }) {
  const allSys = MOCK_NOTIFICATION_HISTORY.filter(n => n.category === 'system')
    .sort((a, b) => (`${b.date} ${b.time}`).localeCompare(`${a.date} ${a.time}`));

  const firstKey = allSys[0] ? `${allSys[0].date}-${allSys[0].time}` : null;
  const initialKey = initialNotif ? `${initialNotif.date}-${initialNotif.time}` : firstKey;
  const [selectedKey, setSelectedKey] = useState(initialKey);

  const selected = allSys.find(n => `${n.date}-${n.time}` === selectedKey) || allSys[0];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rl-bg-2)' }}>
      <TopBar doctor={doctor} onLogout={onLogout} activeScreen="settings" onNavigate={onNavigate} onOpenPatient={onOpenPatient} onOpenAnnouncement={onOpenAnnouncement} />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-8 py-6">
        {/* Breadcrumb · 설정 > 시스템 공지 */}
        <div className="flex items-center gap-1.5 mb-3 font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          <button
            onClick={() => onNavigate('settings')}
            className="hover:underline"
            style={{ color: 'var(--rl-primary)' }}
          >
            Settings
          </button>
          <ChevronRight size={11} />
          <span>System Announcements</span>
        </div>

        <div className="flex items-baseline gap-4 mb-5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-ink-3)' }}>
              System Announcements · {allSys.length}건
            </div>
            <h1 className="font-serif text-3xl" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
              시스템 공지
            </h1>
          </div>
          <button
            onClick={() => onNavigate('settings')}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded text-xs hairline-strong hover:bg-slate-50"
            style={{ color: 'var(--rl-ink-2)' }}
          >
            <ChevronLeft size={12} /> 설정으로
          </button>
        </div>

        {/* Layout: 좌 리스트 + 우 상세 */}
        <div className="grid gap-3" style={{ gridTemplateColumns: '300px 1fr', minHeight: 560 }}>
          {/* List */}
          <div className="hairline rounded bg-white overflow-hidden flex flex-col">
            <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--rl-border-soft)', background: 'var(--rl-bg-3)' }}>
              <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
                {allSys.length} announcements
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {allSys.map(n => {
                const key = `${n.date}-${n.time}`;
                const active = selectedKey === key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedKey(key)}
                    className="w-full text-left px-3 py-2.5 transition"
                    style={{
                      background: active ? 'var(--rl-primary-soft)' : 'transparent',
                      borderLeft: `3px solid ${active ? 'var(--rl-primary)' : 'transparent'}`,
                      borderBottom: '1px solid var(--rl-border-soft)',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--rl-bg-2)'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div className="flex items-baseline gap-2">
                      <SettingsIcon size={11} style={{ color: 'var(--rl-ink-3)', flexShrink: 0 }} />
                      <div className="text-xs font-medium truncate flex-1" style={{ color: 'var(--rl-ink)' }}>{n.title}</div>
                    </div>
                    <div className="font-mono text-[10px] mt-0.5 truncate" style={{ color: 'var(--rl-ink-3)' }}>
                      {n.date} · {n.time}
                    </div>
                    <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--rl-ink-3)' }}>
                      {n.text}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Detail */}
          <div className="hairline rounded bg-white p-6">
            {selected ? <AnnouncementDetail n={selected} /> : (
              <div className="text-center py-20 text-sm" style={{ color: 'var(--rl-ink-3)' }}>
                공지를 선택하세요
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function AnnouncementDetail({ n }) {
  const d = n.detail || {};
  return (
    <div className="fade-in">
      <div className="flex items-baseline gap-3 pb-3" style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
        <span className="chip" style={{ background: 'var(--rl-bg-3)', color: 'var(--rl-ink-2)' }}>
          <SettingsIcon size={10} /> System
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          {d.component || ''}
        </span>
        <span className="ml-auto font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>
          {n.date} {n.time} KST
        </span>
      </div>

      <h2 className="font-serif text-xl mt-4 mb-2" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
        {n.title}
      </h2>
      <div className="text-sm mb-5 leading-relaxed" style={{ color: 'var(--rl-ink-2)' }}>
        {n.text}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {d.version && (
          <div className="p-3 rounded" style={{ background: 'var(--rl-bg-2)' }}>
            <div className="font-mono text-[9px] uppercase tracking-widest mb-0.5" style={{ color: 'var(--rl-ink-3)' }}>Version</div>
            <div className="font-mono text-sm" style={{ color: 'var(--rl-ink)' }}>{d.version}</div>
          </div>
        )}
        {d.deployedBy && (
          <div className="p-3 rounded" style={{ background: 'var(--rl-bg-2)' }}>
            <div className="font-mono text-[9px] uppercase tracking-widest mb-0.5" style={{ color: 'var(--rl-ink-3)' }}>Deployed by</div>
            <div className="text-sm" style={{ color: 'var(--rl-ink)' }}>{d.deployedBy}</div>
          </div>
        )}
      </div>

      {d.changes && (
        <div
          className="p-4 rounded text-sm leading-relaxed"
          style={{ background: 'var(--rl-primary-soft)', borderLeft: '3px solid var(--rl-primary)', color: 'var(--rl-ink)' }}
        >
          <div className="font-mono text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--rl-primary)' }}>
            Changes · 변경 내역
          </div>
          {d.changes}
        </div>
      )}

      <div className="mt-5 pt-3 text-[11px]" style={{ borderTop: '1px solid var(--rl-border-soft)', color: 'var(--rl-ink-3)' }}>
        <span className="font-mono uppercase tracking-widest" style={{ color: 'var(--rl-amber)' }}>⚠ EU AI Act Art. 22</span>
        &nbsp;· 본 공지는 AI 시스템 변경 사항이며, 진단 결과 해석에 영향을 줄 수 있습니다.
      </div>
    </div>
  );
}

/* ============================================================
   MOCK DATA · 오늘 외래 (9명)
   - acknowledged: 의사가 결과를 이미 확인했는지
   - resultAt:     AI 분석 완료 시각 (HH:mm KST)
   ============================================================ */
const MOCK_PATIENTS = [
  {
    time: '08:30', visit: '초진',
    name: '김○○', sex: 'M', age: 58, mrn: '20-145982',
    complaint: '호흡곤란 3개월 · 마른기침 · 체중감소 4kg',
    allergy: 'Penicillin',
    vitals: 'BP 128/76 · HR 88 · RR 22 · SpO₂ 93% (RA) · T 36.6°C',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: true,
    acknowledged: false, resultAt: '08:21',
    pendingEmrUpdates: 2, // EMR 에서 끌어오지 못한 미수신 정보 (vitals/lab 등) — 데모
    topDx: null,
    preview: [
      { name: '특발성 폐섬유증 (IPF)', prob: 0.84, rare: true, dontMiss: true, orpha: 'ORPHA:2032' },
      { name: 'Sarcoidosis',         prob: 0.62, rare: false },
      { name: '과민성 폐렴 (HP)',       prob: 0.41, rare: false },
    ],
  },
  {
    time: '09:00', visit: '재진',
    name: '이○○', sex: 'F', age: 42, mrn: '21-093127',
    complaint: '만성기침 2주 · 가래',
    vitals: 'BP 124/78 · HR 96 · RR 22 · SpO₂ 94% (RA) · T 38.2°C',
    cxr: 'arrived', status: 'ready',
    rare: false, dontMiss: false,
    acknowledged: true, resultAt: '07:55',
    topDx: 'Pneumonia',
    preview: [
      { name: 'Community-acquired Pneumonia', prob: 0.76, rare: false },
      { name: 'Acute Bronchitis',             prob: 0.52, rare: false },
      { name: 'Asthma exacerbation',          prob: 0.18, rare: false },
    ],
  },
  {
    time: '09:30', visit: '초진',
    name: '박○○', sex: 'F', age: 34, mrn: '22-014556',
    complaint: '객혈 · 야간 발한 2주',
    vitals: 'BP 118/72 · HR 102 · RR 22 · SpO₂ 92% (RA) · T 37.8°C',
    cxr: 'arrived', status: 'analyzing',
    rare: true, dontMiss: true,
    topDx: null,
    preview: null,
  },
  {
    time: '10:00', visit: '재진',
    name: '최○○', sex: 'M', age: 67, mrn: '19-445621',
    complaint: '흉통 · 호흡곤란 · 부종',
    vitals: 'BP 144/92 · HR 98 · RR 22 · SpO₂ 91% (RA) · T 36.7°C',
    cxr: 'arrived', status: 'ready',
    rare: false, dontMiss: false,
    acknowledged: true, resultAt: '08:42',
    topDx: 'CHF',
    preview: [
      { name: 'Congestive Heart Failure', prob: 0.81, rare: false },
      { name: 'Pleural Effusion · RT',    prob: 0.54, rare: false },
      { name: 'Pneumonia',                prob: 0.22, rare: false },
    ],
  },
  {
    time: '10:30', visit: '초진',
    name: '정○○', sex: 'F', age: 29, mrn: '22-089433',
    complaint: '호흡곤란 · 재발성 기흉',
    vitals: 'BP 110/68 · HR 84 · RR 20 · SpO₂ 94% (RA) · T 36.5°C',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: false,
    acknowledged: false, resultAt: '08:58',
    pendingEmrUpdates: 1, // EMR 미수신 정보 — 데모
    topDx: null,
    preview: [
      { name: 'Lymphangioleiomyomatosis (LAM)', prob: 0.58, rare: true, orpha: 'ORPHA:538' },
      { name: 'Pulmonary Langerhans Cell Histiocytosis', prob: 0.31, rare: true, orpha: 'ORPHA:99874' },
      { name: '재발성 기흉 (idiopathic)',     prob: 0.18, rare: false },
    ],
  },
  {
    time: '11:00', visit: '재진',
    name: '한○○', sex: 'M', age: 71, mrn: '18-332108',
    complaint: '만성 흡연력 · 객담 · 운동 시 호흡곤란',
    vitals: 'BP 138/86 · HR 82 · RR 20 · SpO₂ 92% (RA) · T 36.4°C',
    cxr: 'pending', status: 'pending',
    rare: false, dontMiss: false,
    topDx: null,
  },
  {
    time: '11:30', visit: '초진',
    name: '윤○○', sex: 'F', age: 51, mrn: '22-145012',
    complaint: '흉통 · 두근거림 1주',
    vitals: 'BP 128/82 · HR 90 · RR 18 · SpO₂ 96% (RA) · T 36.6°C',
    cxr: 'arrived', status: 'analyzing',
    rare: false, dontMiss: false,
    topDx: null,
  },
  {
    time: '13:00', visit: '초진',
    name: '오○○', sex: 'M', age: 45, mrn: '22-145098',
    complaint: '단순 건강검진 · CXR 이상 소견 FU',
    vitals: 'BP 122/78 · HR 76 · RR 16 · SpO₂ 97% (RA) · T 36.5°C',
    cxr: 'pending', status: 'pending',
    rare: false, dontMiss: false,
    topDx: null,
  },
  {
    time: '13:30', visit: '초진',
    name: '장○○', sex: 'F', age: 62, mrn: '22-145103',
    complaint: '기침 · 체중감소 · 류마티스 관절염 과거력',
    vitals: 'BP 130/80 · HR 88 · RR 20 · SpO₂ 93% (RA) · T 36.9°C',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: true,
    acknowledged: false, resultAt: '07:12',
    topDx: null,
    preview: [
      { name: 'RA-associated ILD (NSIP pattern)', prob: 0.69, rare: true, dontMiss: true, orpha: 'ORPHA:79126' },
      { name: '과민성 폐렴 (HP)',                    prob: 0.42, rare: false },
      { name: 'IPF',                              prob: 0.28, rare: true, orpha: 'ORPHA:2032' },
    ],
  },
  {
    time: '14:00', visit: '재진',
    name: '원○○', sex: 'F', age: 22, mrn: '23-145220',
    complaint: '과호흡 · 두근거림 · 시험 기간 스트레스',
    vitals: 'BP 128/82 · HR 112 · RR 28 · SpO₂ 99% (RA) · T 36.7°C',
    cxr: 'arrived', status: 'ready',
    rare: false, dontMiss: false,
    acknowledged: false, resultAt: '13:42',
    topDx: 'HVS',
    preview: [
      { name: 'Hyperventilation Syndrome (과호흡증후군)', prob: 0.71, rare: false },
      { name: 'Anxiety · Panic attack',                  prob: 0.58, rare: false },
      { name: 'Asthma exacerbation',                     prob: 0.16, rare: false },
    ],
  },
  /* 외국인 환자 데모 · 영문 가독성 검증용 (BiText helper로 lang="en" 자동 부착) */
  {
    time: '14:30', visit: '초진',
    name: 'John Müller', sex: 'M', age: 47, mrn: '26-FOR0042',
    complaint: 'Progressive dyspnea on exertion · 6 weeks · non-productive cough',
    vitals: 'BP 132/84 · HR 92 · RR 22 · SpO₂ 93% (RA) · T 36.8°C',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: false,
    acknowledged: false, resultAt: '14:18',
    topDx: 'IPF',
    preview: [
      { name: 'Idiopathic Pulmonary Fibrosis (IPF)', prob: 0.72, rare: true, orpha: 'ORPHA:2032' },
      { name: 'Hypersensitivity Pneumonitis',        prob: 0.41, rare: false },
      { name: 'Sarcoidosis',                          prob: 0.24, rare: false },
    ],
  },
];

/* ============================================================
   MOCK DATA · 과거 환자 (검색 섹션 데모용)
   visitDate: 'YYYY-MM-DD' (오늘 = 2026-04-23)
   ============================================================ */
const MOCK_PATIENT_HISTORY = [
  {
    time: '14:00', visit: '재진',
    visitDate: '2026-04-22',
    name: '강○○', sex: 'M', age: 73, mrn: '15-228714',
    complaint: '만성 호흡곤란 · 흡연력 50 pack-year',
    cxr: 'arrived', status: 'ready',
    rare: false, dontMiss: false,
    acknowledged: true, resultAt: '13:48',
    preview: [
      { name: 'COPD · GOLD III', prob: 0.79, rare: false },
      { name: 'Bronchiectasis',  prob: 0.34, rare: false },
    ],
  },
  {
    time: '10:30', visit: '재진',
    visitDate: '2026-04-16',
    name: '문○○', sex: 'F', age: 38, mrn: '20-118245',
    complaint: '활동 시 호흡곤란 · 광범위 ground-glass',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: false,
    acknowledged: true, resultAt: '10:12',
    preview: [
      { name: 'Nonspecific Interstitial Pneumonia (NSIP)', prob: 0.66, rare: true, orpha: 'ORPHA:79126' },
      { name: '과민성 폐렴 (HP)', prob: 0.39, rare: false },
    ],
  },
  {
    time: '11:15', visit: '초진',
    visitDate: '2026-03-28',
    name: '서○○', sex: 'M', age: 29, mrn: '21-301122',
    complaint: '재발성 폐렴 · 면역결핍 의심',
    allergy: 'Sulfa',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: true,
    acknowledged: true, resultAt: '11:01',
    preview: [
      { name: 'Common Variable Immune Deficiency (CVID)', prob: 0.71, rare: true, dontMiss: true, orpha: 'ORPHA:1572' },
      { name: 'Bronchiectasis · post-infectious', prob: 0.48, rare: false },
    ],
  },
  {
    time: '09:00', visit: '재진',
    visitDate: '2026-03-04',
    name: '구○○', sex: 'F', age: 56, mrn: '17-882034',
    complaint: '천식 악화 · 야간 기침',
    cxr: 'arrived', status: 'ready',
    rare: false, dontMiss: false,
    acknowledged: true, resultAt: '08:48',
    preview: [
      { name: 'Asthma · severe persistent', prob: 0.83, rare: false },
    ],
  },
  {
    time: '13:30', visit: '초진',
    visitDate: '2026-02-12',
    name: '백○○', sex: 'M', age: 64, mrn: '22-145210',
    complaint: '체중감소 · 객혈 · 림프절 종대',
    cxr: 'arrived', status: 'ready',
    rare: false, dontMiss: true,
    acknowledged: true, resultAt: '13:14',
    preview: [
      { name: '폐결핵 · 활동성',        prob: 0.74, rare: false, dontMiss: true },
      { name: 'Lung Cancer (NSCLC)', prob: 0.41, rare: false },
    ],
  },
  {
    time: '15:00', visit: '재진',
    visitDate: '2026-01-30',
    name: '나○○', sex: 'F', age: 47, mrn: '19-557741',
    complaint: '아급성 발열 · 양측성 결절',
    cxr: 'arrived', status: 'ready',
    rare: true, dontMiss: false,
    acknowledged: true, resultAt: '14:42',
    preview: [
      { name: 'Granulomatosis with Polyangiitis (GPA)', prob: 0.62, rare: true, orpha: 'ORPHA:900' },
      { name: 'Sarcoidosis', prob: 0.44, rare: false },
    ],
  },
];
