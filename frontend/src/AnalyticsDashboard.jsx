/* ============================================================
   AnalyticsDashboard · 분석 대시보드 (#10)
   임상 + AI 성능 통합 화면. 워크리스트 상단 nav '분석 대시보드' 진입.

   데이터 소스: /mock_fhir/analytics/*.json (정적)
   차트: 외부 라이브러리 0 — 인라인 SVG (CXR heatmap과 동일 톤)
   ============================================================ */
import React, { useState, useEffect } from 'react';
import {
  Stethoscope, Users, Flame, CheckCircle2, Clock, Target,
  ScanLine, RefreshCw, Shield, TrendingUp, TrendingDown, AlertTriangle, Loader2,
  CalendarRange, Activity,
} from 'lucide-react';

/* 통계 기간 옵션 — 1주 / 보름 / 1달 / 3개월. 기본 = 1달. */
const PERIODS = [
  { k: '7',  label: '1주',   days: 7  },
  { k: '15', label: '보름',  days: 15 },
  { k: '30', label: '1달',   days: 30 },
  { k: '90', label: '3개월', days: 90 },
];

/* 선택 기간(days) 기준으로 통계를 도출.
   daily_volume(일별 dated)에서 최근 N일 윈도를 잘라 환자/희귀/동의율을 집계하고,
   날짜축이 없는 진단 분포·희귀 분포는 기간 비중(frac)으로 비례 추정한다. */
function derivePeriod(data, days) {
  const all = data.daily_volume.items;
  const n   = Math.min(days, all.length);
  const win = all.slice(-n);
  const prev = all.slice(Math.max(0, all.length - 2 * n), all.length - n);
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const totalAll  = sum(all, x => x.count) || 1;
  const patients  = sum(win, x => x.count);
  const rareCount = sum(win, x => x.rare_count || 0);
  const agreement = win.length ? sum(win, x => x.agreement) / win.length : 0;
  const prevPat   = sum(prev, x => x.count);
  const prevRare  = sum(prev, x => x.rare_count || 0);
  const prevAgree = prev.length ? sum(prev, x => x.agreement) / prev.length : agreement;
  const frac  = patients / totalAll;
  const scale = (v) => Math.max(0, Math.round(v * frac));
  return {
    days, win,
    patients,
    rareCount,
    rareRate: patients ? rareCount / patients : 0,
    agreement,
    perDay: win.length ? patients / win.length : 0,
    deltaPatients: patients - prevPat,
    deltaRareRate: (patients ? rareCount / patients : 0) - (prevPat ? prevRare / prevPat : 0),
    deltaAgreement: agreement - prevAgree,
    hasPrev: prev.length > 0,
    topDiagnoses: data.top_diagnoses.items.map(d => ({ ...d, count: scale(d.count) })),
    rareDist: {
      total: scale(data.rare_distribution.total),
      items: data.rare_distribution.items.map(d => ({ ...d, count: scale(d.count) })),
    },
  };
}

const ANALYTICS_BASE = '/mock_fhir/analytics';
const FILES = [
  'kpi.json',
  'top_diagnoses.json',
  'daily_volume.json',
  'rare_distribution.json',
  'label_positive_rate.json',
  'llm_verify_effect.json',
  'retry_triggers.json',
];

export default function AnalyticsDashboard({ TopBar, doctor, onLogout, onNavigate, onOpenPatient, onOpenAnnouncement }) {
  const [tab, setTab] = useState('clinical'); // 'clinical' | 'ai'
  const [period, setPeriod] = useState('30'); // 통계 기간 — 기본 1달
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all(
      FILES.map(f => fetch(`${ANALYTICS_BASE}/${f}`).then(r => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      }))
    )
      .then(([kpi, top_diagnoses, daily_volume, rare_distribution, label_positive_rate, llm_verify_effect, retry_triggers]) => {
        setData({ kpi, top_diagnoses, daily_volume, rare_distribution, label_positive_rate, llm_verify_effect, retry_triggers });
      })
      .catch(e => setError(e.message));
  }, []);

  return (
    <div className="min-h-screen" style={{ background: 'var(--rl-bg-2)' }}>
      <TopBar
        doctor={doctor}
        onLogout={onLogout}
        activeScreen="dashboard"
        onNavigate={onNavigate}
        onOpenPatient={onOpenPatient}
        onOpenAnnouncement={onOpenAnnouncement}
      />

      <div className="max-w-[1440px] mx-auto px-8 py-6">
        {/* Header */}
        <div className="flex items-baseline gap-3 mb-4">
          <h1 className="font-serif text-2xl" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
            분석 대시보드
          </h1>
          <div className="font-mono text-[11px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
            Clinical · AI Performance
          </div>
          <div className="ml-auto font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>
            데이터 출처: Mock /mock_fhir/analytics · 최종 갱신 2026-05-28 09:00
          </div>
        </div>

        {/* Tab switcher + 기간 선택 (임상 지표 탭에만 노출) */}
        <div className="flex items-end justify-between gap-3 mb-4" style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
          <DashTabs active={tab} onChange={setTab} />
          {tab === 'clinical' && <PeriodSelector value={period} onChange={setPeriod} />}
        </div>

        {error && (
          <div className="hairline rounded bg-white p-6 text-sm" style={{ color: 'var(--rl-critical)' }}>
            <AlertTriangle size={16} className="inline mr-2" />
            데이터 로드 실패: {error}
          </div>
        )}

        {!data && !error && (
          <div className="hairline rounded bg-white p-12 text-center text-sm flex items-center justify-center gap-2" style={{ color: 'var(--rl-primary)' }}>
            <Loader2 size={16} className="spin" /> 통계 로드 중…
          </div>
        )}

        {data && tab === 'clinical' && <ClinicalTab data={data} period={Number(period)} />}
        {data && tab === 'ai' && <AiTab data={data} />}

        {/* HITL footer */}
        <div className="mt-6 px-4 py-2 text-[11px] flex items-start gap-2 rounded" style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)' }}>
          <AlertTriangle size={12} style={{ color: 'var(--rl-amber)', marginTop: 1, flexShrink: 0 }} />
          <div style={{ color: 'var(--rl-ink-2)' }}>
            <span className="font-medium" style={{ color: 'var(--rl-amber)' }}>본 통계는 AI 결과의 누적 집계이며 임상 결정의 근거가 아닙니다.</span>{' '}
            의사 동의율·정확도 지표는 의사가 명시적으로 동의/수정한 케이스만 집계.
            <span className="font-mono ml-2" style={{ color: 'var(--rl-ink-3)' }}>[EU AI Act Art. 22]</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------- Tab switcher ----------- */
function DashTabs({ active, onChange }) {
  const tabs = [
    { k: 'clinical', label: '임상 지표', icon: <Stethoscope size={13} /> },
    { k: 'ai',       label: 'AI 모델 성능', icon: <ScanLine size={13} /> },
  ];
  return (
    <div className="flex items-center gap-1">
      {tabs.map(t => {
        const isActive = active === t.k;
        return (
          <button
            key={t.k}
            onClick={() => onChange(t.k)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm transition"
            style={{
              color: isActive ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
              fontWeight: isActive ? 600 : 400,
              borderBottom: isActive ? '2px solid var(--rl-primary)' : '2px solid transparent',
              marginBottom: '-1px',
              background: 'none',
              cursor: 'pointer',
            }}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ----------- 기간 선택 (segmented control) ----------- */
function PeriodSelector({ value, onChange }) {
  return (
    <div className="flex items-center gap-2 pb-1.5">
      <CalendarRange size={13} style={{ color: 'var(--rl-ink-3)' }} />
      <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>통계 기간</span>
      <div className="flex items-center rounded p-0.5" style={{ background: 'var(--rl-bg-3)', border: '1px solid var(--rl-border-soft)' }}>
        {PERIODS.map(p => {
          const on = value === p.k;
          return (
            <button
              key={p.k}
              onClick={() => onChange(p.k)}
              className="px-3 py-1 rounded text-xs font-medium transition"
              style={{
                background: on ? 'var(--rl-primary)' : 'transparent',
                color: on ? 'white' : 'var(--rl-ink-2)',
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   TAB · CLINICAL
   ============================================================ */
function ClinicalTab({ data, period }) {
  const p = derivePeriod(data, period);
  const pLabel = (PERIODS.find(x => Number(x.k) === period) || {}).label || `${period}일`;
  const range = p.win.length
    ? `${p.win[0].date} ~ ${p.win[p.win.length - 1].date}`
    : '';

  // delta 객체 — 직전 동기간 대비
  const dPat = { trend: p.deltaPatients >= 0 ? 'up' : 'down', delta: p.deltaPatients, delta_unit: '직전 동기간' };
  const dRare = {
    trend: p.deltaRareRate >= 0 ? 'up' : 'down',
    delta: (p.deltaRareRate * 100).toFixed(1), delta_unit: 'pp',
  };
  const dAgree = {
    trend: p.deltaAgreement >= 0 ? 'up' : 'down-good',
    delta: (p.deltaAgreement * 100).toFixed(1), delta_unit: 'pp',
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 기간 요약 배너 */}
      <div className="flex items-center gap-2 px-3 py-2 rounded text-[11px]"
        style={{ background: 'var(--rl-primary-soft)', border: '1px solid var(--rl-border-soft)' }}>
        <Activity size={13} style={{ color: 'var(--rl-primary)' }} />
        <span className="font-medium" style={{ color: 'var(--rl-primary)' }}>최근 {pLabel} 통계</span>
        <span className="font-mono" style={{ color: 'var(--rl-ink-3)' }}>{range}</span>
        <span className="ml-auto" style={{ color: 'var(--rl-ink-2)' }}>
          기간 내 진단 <b style={{ color: 'var(--rl-ink)' }}>{p.patients.toLocaleString()}</b>건 ·
          희귀질환 의심 <b style={{ color: 'var(--rl-rare)' }}>{p.rareCount.toLocaleString()}</b>건
        </span>
      </div>

      {/* KPI strip — 선택 기간 기준 */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <KpiCard
          label={`진단 건수 · 최근 ${pLabel}`}
          value={p.patients.toLocaleString()}
          unit="건"
          delta={p.hasPrev ? dPat : null}
          icon={<Users size={16} />}
          accent="primary"
        />
        <KpiCard
          label="희귀질환 검출률"
          value={(p.rareRate * 100).toFixed(1)}
          unit="%"
          delta={p.hasPrev ? dRare : null}
          icon={<Flame size={16} />}
          accent="rare"
        />
        <KpiCard
          label="의사 동의율 (top-3)"
          value={(p.agreement * 100).toFixed(0)}
          unit="%"
          delta={p.hasPrev ? dAgree : null}
          icon={<CheckCircle2 size={16} />}
          accent="teal"
        />
        <KpiCard
          label="일 평균 진단"
          value={p.perDay.toFixed(1)}
          unit="건/일"
          delta={null}
          icon={<Clock size={16} />}
          accent="ink"
        />
      </div>

      {/* Top 진단 + 일별 추이 (2-col) */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.3fr)' }}>
        <DashPanel title="진단 분포 (Top)" mono={`최근 ${pLabel} · 기간 비례 추정`}>
          <TopDiagnosesBar items={p.topDiagnoses} />
        </DashPanel>
        <DashPanel title="일별 진단 수" mono={`최근 ${pLabel} · 동의율 보조축`}>
          <DailyVolumeChart items={p.win} />
        </DashPanel>
      </div>

      {/* 희귀질환 분포 (도넛) — full width */}
      <DashPanel title="희귀질환 ORPHA 분포" mono={`최근 ${pLabel} · 총 ${p.rareDist.total}건 · Phase 5 listing 기준`}>
        <RareDonut items={p.rareDist.items} total={p.rareDist.total} />
      </DashPanel>
    </div>
  );
}

/* ============================================================
   TAB · AI PERFORMANCE
   ============================================================ */
function AiTab({ data }) {
  const k = data.kpi.ai;
  const llm = data.llm_verify_effect;
  return (
    <div className="flex flex-col gap-4">
      {/* KPI strip */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <KpiCard
          label="Top-1 정확도"
          value={(k.top1_accuracy.value * 100).toFixed(0)}
          unit="%"
          delta={{ ...k.top1_accuracy, value: (k.top1_accuracy.delta * 100).toFixed(1) }}
          icon={<Target size={16} />}
          accent="primary"
        />
        <KpiCard
          label="Top-3 정확도"
          value={(k.top3_accuracy.value * 100).toFixed(0)}
          unit="%"
          delta={{ ...k.top3_accuracy, value: (k.top3_accuracy.delta * 100).toFixed(1) }}
          icon={<CheckCircle2 size={16} />}
          accent="teal"
        />
        <KpiCard
          label="Phase 4 재조정률"
          value={(k.phase4_revised_ratio.value * 100).toFixed(1)}
          unit="%"
          delta={{ ...k.phase4_revised_ratio, value: (k.phase4_revised_ratio.delta * 100).toFixed(1) }}
          icon={<Shield size={16} />}
          accent="ink"
        />
        <KpiCard
          label="재분석 발생률"
          value={(k.retry_rate.value * 100).toFixed(0)}
          unit="%"
          delta={{ ...k.retry_rate, value: (k.retry_rate.delta * 100).toFixed(1) }}
          icon={<RefreshCw size={16} />}
          accent="rare"
        />
      </div>

      {/* CheXpert label 양성률 + Retry triggers */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        <DashPanel title="CheXpert 14 label 양성률" mono="DenseNet-121 · 누적 1,247 케이스">
          <LabelPositiveBar items={data.label_positive_rate.items} total={data.label_positive_rate.total_cases} />
        </DashPanel>
        <DashPanel title="재분석 트리거 분포" mono="3-버튼별 사용 횟수">
          <RetryTriggersDonut items={data.retry_triggers.items} total={data.retry_triggers.total_executions} />
        </DashPanel>
      </div>

      {/* LLM verify effect — agreement + guardrails */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)' }}>
        <DashPanel title="Phase 3 ↔ Phase 4 일치도" mono="Bedrock Sonnet 검증 효과">
          <LlmAgreementBlock llm={llm} />
        </DashPanel>
        <DashPanel title="Phase 4 Guardrail 발동 분포" mono="6 guardrail × 잡힌 케이스">
          <GuardrailBars guardrails={llm.guardrails_caught} />
        </DashPanel>
      </div>
    </div>
  );
}

/* ============================================================
   PANEL · 공용 카드
   ============================================================ */
function DashPanel({ title, mono, children }) {
  return (
    <div className="hairline rounded bg-white">
      <div className="px-3 py-2 flex items-baseline gap-2" style={{ borderBottom: '1px solid var(--rl-border-soft)' }}>
        <div className="font-mono text-[10px] uppercase tracking-widest flex-shrink-0" style={{ color: 'var(--rl-ink-3)' }}>
          {mono}
        </div>
        <div className="text-sm font-medium" style={{ color: 'var(--rl-ink)' }}>{title}</div>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

/* ============================================================
   KPI CARD
   ============================================================ */
function KpiCard({ label, value, unit, delta, icon, accent = 'primary' }) {
  const palette = {
    primary: { fg: 'var(--rl-primary)', bg: 'var(--rl-primary-soft)' },
    teal:    { fg: 'var(--rl-teal)',    bg: 'var(--rl-teal-soft)' },
    rare:    { fg: 'var(--rl-rare)',    bg: 'var(--rl-rare-soft)' },
    ink:     { fg: 'var(--rl-ink-2)',   bg: 'var(--rl-bg-3)' },
  }[accent];

  // delta trend → color
  const trendColor = (() => {
    if (!delta) return 'var(--rl-ink-3)';
    switch (delta.trend) {
      case 'up':         return 'var(--rl-teal)';
      case 'down':       return 'var(--rl-critical)';
      case 'up-bad':     return 'var(--rl-amber)';
      case 'down-good':  return 'var(--rl-teal)';
      default:           return 'var(--rl-ink-3)';
    }
  })();

  return (
    <div className="hairline rounded bg-white p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0" style={{ background: palette.bg, color: palette.fg }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="text-[11px] truncate" style={{ color: 'var(--rl-ink-3)' }}>{label}</div>
        <div className="flex items-baseline gap-1 mt-0.5">
          <span className="font-serif text-2xl leading-none" style={{ color: 'var(--rl-ink)' }}>{value}</span>
          <span className="text-xs" style={{ color: 'var(--rl-ink-3)' }}>{unit}</span>
        </div>
        {delta && (
          <div className="flex items-center gap-1 mt-1 text-[10px] font-mono" style={{ color: trendColor }}>
            {(delta.trend === 'up' || delta.trend === 'up-bad') && <TrendingUp size={10} />}
            {(delta.trend === 'down' || delta.trend === 'down-good') && <TrendingDown size={10} />}
            <span>{delta.delta > 0 ? '+' : ''}{delta.delta}{delta.delta_unit ? ' ' + delta.delta_unit : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   CHART · Top diagnoses (horizontal bar)
   ============================================================ */
function TopDiagnosesBar({ items }) {
  const max = Math.max(...items.map(i => i.count));
  return (
    <div className="flex flex-col gap-1">
      {items.map(d => {
        const w = (d.count / max) * 100;
        const fg = d.rare ? 'var(--rl-rare)' : d.dontMiss ? 'var(--rl-amber)' : 'var(--rl-primary)';
        const bg = d.rare ? 'var(--rl-rare-soft)' : d.dontMiss ? 'var(--rl-amber-soft)' : 'var(--rl-primary-soft)';
        return (
          <div key={d.name_en} className="flex items-center gap-2 text-[11px]" title={d.name_en}>
            <span
              className="truncate"
              style={{ color: 'var(--rl-ink)', minWidth: 200, maxWidth: 200, fontWeight: d.rare || d.dontMiss ? 500 : 400 }}
            >
              {d.name_kr}
              {d.rare && <Flame size={9} style={{ color: 'var(--rl-rare)', display: 'inline', marginLeft: 4 }} />}
              {d.dontMiss && <AlertTriangle size={9} style={{ color: 'var(--rl-amber)', display: 'inline', marginLeft: 4 }} />}
            </span>
            <div className="flex-1 h-3 rounded" style={{ background: bg, overflow: 'hidden' }}>
              <div className="h-full rounded" style={{ width: `${w}%`, background: fg, transition: 'width 0.4s' }} />
            </div>
            <span className="font-mono text-[10px] w-10 text-right" style={{ color: 'var(--rl-ink-2)' }}>{d.count}</span>
            <span className="font-mono text-[9px] w-12 text-right" style={{ color: 'var(--rl-ink-3)' }}>{d.icd10}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   CHART · Daily volume (line + bar overlay)
   ============================================================ */
function DailyVolumeChart({ items }) {
  // 색맹 대응: 파랑(진단수) + 주황(동의율). 청록/녹색 조합 회피.
  // 범례를 별도 박스로 두지 않고 좌·우 축 끝에 인라인 라벨로 직접 표기.
  const COL_COUNT = 'var(--rl-primary)';
  const COL_COUNT_SOFT = 'var(--rl-primary-soft)';
  const COL_AGREE = 'var(--rl-amber)';
  const W = 560, H = 200;
  const PAD = { top: 18, right: 52, bottom: 30, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const maxCount = Math.max(...items.map(i => i.count)) || 1;
  const xAt = i => PAD.left + (i / Math.max(1, items.length - 1)) * innerW;
  const yCount = c => PAD.top + innerH - (c / maxCount) * innerH;
  const yAgree = a => PAD.top + innerH - (a - 0.7) / 0.3 * innerH;

  const [hover, setHover] = useState(null); // index or null

  const linePoints = items.map((d, i) => `${xAt(i)},${yCount(d.count)}`).join(' ');
  const agreePoints = items.map((d, i) => `${xAt(i)},${yAgree(d.agreement)}`).join(' ');
  const barW = (innerW / items.length) * 0.55;

  return (
    <div style={{ position: 'relative', overflow: 'visible' }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" width="100%" style={{ display: 'block' }}
           onMouseLeave={() => setHover(null)}>
        {/* Grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
          const y = PAD.top + t * innerH;
          return <line key={t} x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y} stroke="var(--rl-border-soft)" strokeWidth="0.5" />;
        })}

        {/* Bar (count) */}
        {items.map((d, i) => {
          const x = xAt(i);
          const y = yCount(d.count);
          return <rect key={d.date} x={x - barW / 2} y={y} width={barW} height={PAD.top + innerH - y}
                       fill={COL_COUNT_SOFT} opacity={hover === null || hover === i ? 1 : 0.4} />;
        })}

        {/* Line (count) */}
        <polyline points={linePoints} fill="none" stroke={COL_COUNT} strokeWidth="1.5" />
        {/* Agreement line (right axis) — 주황 + dashed (선 형태도 다르게 → 색맹 이중 단서) */}
        <polyline points={agreePoints} fill="none" stroke={COL_AGREE} strokeWidth="1.5" strokeDasharray="4 2" />

        {/* 인라인 축 라벨 — 좌/우 축 상단에 직접 배치 (범례 대체) */}
        <text x={PAD.left - 6} y={PAD.top - 6} textAnchor="end" fontSize="9.5" fill={COL_COUNT} fontFamily="monospace" fontWeight="600">진단 수</text>
        <text x={PAD.left + innerW + 6} y={PAD.top - 6} textAnchor="start" fontSize="9.5" fill={COL_AGREE} fontFamily="monospace" fontWeight="600">동의율</text>

        {/* Y axis left labels (count) */}
        {[0, 0.5, 1].map(t => {
          const y = PAD.top + (1 - t) * innerH;
          return (
            <text key={t} x={PAD.left - 4} y={y + 3} textAnchor="end" fontSize="9" fill="var(--rl-ink-3)" fontFamily="monospace">
              {Math.round(maxCount * t)}
            </text>
          );
        })}
        {/* Y axis right labels (agreement) */}
        {[0.7, 0.85, 1.0].map(a => {
          const y = yAgree(a);
          return (
            <text key={a} x={PAD.left + innerW + 4} y={y + 3} fontSize="9" fill={COL_AGREE} fontFamily="monospace">
              {Math.round(a * 100)}%
            </text>
          );
        })}
        {/* X axis labels (sparse) */}
        {[0, Math.floor(items.length / 2), items.length - 1].map(i => (
          <text key={i} x={xAt(i)} y={H - 10} textAnchor="middle" fontSize="9" fill="var(--rl-ink-3)" fontFamily="monospace">
            {items[i].date.slice(5)}
          </text>
        ))}

        {/* Hover crosshair + emphasized points */}
        {hover !== null && (
          <>
            <line x1={xAt(hover)} y1={PAD.top} x2={xAt(hover)} y2={PAD.top + innerH} stroke="var(--rl-ink-3)" strokeWidth="0.5" strokeDasharray="2 2" />
            <circle cx={xAt(hover)} cy={yCount(items[hover].count)} r="3.5" fill={COL_COUNT} stroke="white" strokeWidth="1.5" />
            <circle cx={xAt(hover)} cy={yAgree(items[hover].agreement)} r="3.5" fill={COL_AGREE} stroke="white" strokeWidth="1.5" />
          </>
        )}

        {/* Hover capture — 투명 rect 로 마우스 이벤트 받음 */}
        {items.map((d, i) => {
          const cellW = innerW / items.length;
          return <rect key={'h' + i} x={xAt(i) - cellW / 2} y={PAD.top} width={cellW} height={innerH}
                       fill="transparent" onMouseEnter={() => setHover(i)} style={{ cursor: 'crosshair' }} />;
        })}
      </svg>

      {/* Tooltip overlay */}
      {hover !== null && (() => {
        const d = items[hover];
        const cellW = innerW / items.length;
        const xPct = ((xAt(hover) + cellW * 0.6) / W) * 100;
        const onRight = xPct > 70;
        return (
          <div style={{
            position: 'absolute', top: 8, [onRight ? 'right' : 'left']: onRight ? `${100 - ((xAt(hover) - cellW * 0.6) / W) * 100}%` : `${xPct}%`,
            background: 'rgba(10,22,40,0.94)', color: 'white', padding: '6px 10px', borderRadius: 4,
            fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.5,
            pointerEvents: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.25)', whiteSpace: 'nowrap',
          }}>
            <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 9.5, marginBottom: 2 }}>{d.date}</div>
            <div><span style={{ color: '#7BB3F2' }}>■</span> 진단 <b>{d.count}</b>건</div>
            <div><span style={{ color: '#FBBF77' }}>■</span> 동의 <b>{Math.round(d.agreement * 100)}%</b></div>
            {typeof d.rare_count === 'number' && <div style={{ color: 'rgba(255,255,255,0.6)' }}>희귀 {d.rare_count}건</div>}
          </div>
        );
      })()}
    </div>
  );
}

/* ============================================================
   CHART · Rare distribution (donut + legend)
   ============================================================ */
function RareDonut({ items, total }) {
  const PALETTE = ['#6B21A8', '#9333EA', '#A855F7', '#C084FC', '#0C447C', '#0E8574', '#94A3B8'];
  const cx = 90;
  const cy = 90;
  const rOuter = 80;
  const rInner = 48;
  let acc = 0;

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 180 180" width="180" height="180" style={{ flexShrink: 0 }}>
        {items.map((d, i) => {
          const a0 = (acc / total) * 2 * Math.PI - Math.PI / 2;
          acc += d.count;
          const a1 = (acc / total) * 2 * Math.PI - Math.PI / 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const x0 = cx + rOuter * Math.cos(a0);
          const y0 = cy + rOuter * Math.sin(a0);
          const x1 = cx + rOuter * Math.cos(a1);
          const y1 = cy + rOuter * Math.sin(a1);
          const xi0 = cx + rInner * Math.cos(a1);
          const yi0 = cy + rInner * Math.sin(a1);
          const xi1 = cx + rInner * Math.cos(a0);
          const yi1 = cy + rInner * Math.sin(a0);
          const path = `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${xi0} ${yi0} A ${rInner} ${rInner} 0 ${large} 0 ${xi1} ${yi1} Z`;
          const pct = total ? (d.count / total * 100).toFixed(1) : '0.0';
          return (
            <path key={d.name_kr} d={path} fill={PALETTE[i % PALETTE.length]} stroke="white" strokeWidth="1.5"
                  style={{ cursor: 'pointer' }}>
              <title>{`${d.name_kr}${d.orpha ? ' (' + d.orpha + ')' : ''} — ${d.count}건 · ${pct}%`}</title>
            </path>
          );
        })}
        {/* Center label */}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="22" fontFamily="serif" fill="var(--rl-rare)">{total}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="var(--rl-ink-3)">RARE TOTAL</text>
      </svg>

      <div className="flex flex-col gap-1.5 flex-1 min-w-0">
        {items.map((d, i) => {
          const pct = (d.count / total * 100).toFixed(1);
          return (
            <div key={d.name_kr} className="flex items-center gap-2 text-[11px]" style={{ minWidth: 0 }}>
              <span className="inline-block flex-shrink-0" style={{ width: 10, height: 10, borderRadius: 2, background: PALETTE[i % PALETTE.length] }} />
              <span className="truncate" style={{ color: 'var(--rl-ink)', flex: 1, minWidth: 0 }}>
                {d.name_kr}
              </span>
              {d.orpha && (
                <span className="font-mono text-[9px] flex-shrink-0" style={{ color: 'var(--rl-rare)' }}>{d.orpha}</span>
              )}
              <span className="font-mono text-[10px] w-8 text-right" style={{ color: 'var(--rl-ink-2)' }}>{d.count}</span>
              <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--rl-ink-3)' }}>{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   CHART · CheXpert label 양성률 (vertical bar)
   ============================================================ */
function LabelPositiveBar({ items, total }) {
  const max = Math.max(...items.map(i => i.rate));
  return (
    <div className="flex flex-col gap-1">
      {items.map(l => {
        const w = (l.rate / max) * 100;
        return (
          <div key={l.name} className="flex items-center gap-2 text-[11px]"
               title={`${l.name} — 양성률 ${(l.rate * 100).toFixed(1)}% · 양성 ${l.positive}건`}>
            <span className="truncate" style={{ minWidth: 160, maxWidth: 160, color: 'var(--rl-ink)' }}>
              {l.name}
            </span>
            <div className="flex-1 h-3 rounded" style={{ background: 'var(--rl-bg-3)', overflow: 'hidden' }}>
              <div className="h-full rounded" style={{ width: `${w}%`, background: 'var(--rl-critical)', opacity: 0.85 }} />
            </div>
            <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--rl-critical)' }}>
              {(l.rate * 100).toFixed(1)}%
            </span>
            <span className="font-mono text-[9px] w-12 text-right" style={{ color: 'var(--rl-ink-3)' }}>{l.positive}</span>
          </div>
        );
      })}
      <div className="text-[10px] mt-2 font-mono" style={{ color: 'var(--rl-ink-3)' }}>
        총 {total.toLocaleString()} CXR · 양성 threshold ≥ 0.50
      </div>
    </div>
  );
}

/* ============================================================
   CHART · Retry triggers (donut)
   ============================================================ */
function RetryTriggersDonut({ items, total }) {
  const PALETTE = { no_retry: '#E2E8F0', rerun_image: '#0C447C', rerun_all: '#A32D2D', rerun_rare: '#6B21A8' };
  const cx = 70;
  const cy = 70;
  const rOuter = 60;
  const rInner = 36;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" width="140" height="140" style={{ flexShrink: 0 }}>
        {items.map(d => {
          const a0 = (acc / total) * 2 * Math.PI - Math.PI / 2;
          acc += d.count;
          const a1 = (acc / total) * 2 * Math.PI - Math.PI / 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const x0 = cx + rOuter * Math.cos(a0);
          const y0 = cy + rOuter * Math.sin(a0);
          const x1 = cx + rOuter * Math.cos(a1);
          const y1 = cy + rOuter * Math.sin(a1);
          const xi0 = cx + rInner * Math.cos(a1);
          const yi0 = cy + rInner * Math.sin(a1);
          const xi1 = cx + rInner * Math.cos(a0);
          const yi1 = cy + rInner * Math.sin(a0);
          const pct = total ? (d.count / total * 100).toFixed(1) : '0.0';
          return (
            <path key={d.kind}
              d={`M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${xi0} ${yi0} A ${rInner} ${rInner} 0 ${large} 0 ${xi1} ${yi1} Z`}
              fill={PALETTE[d.kind]} stroke="white" strokeWidth="1.5" style={{ cursor: 'pointer' }}>
              <title>{`${d.label} — ${d.count}건 · ${pct}%`}</title>
            </path>
          );
        })}
      </svg>
      <div className="flex flex-col gap-1.5 flex-1 min-w-0">
        {items.map(d => (
          <div key={d.kind} className="flex items-center gap-2 text-[11px]">
            <span className="inline-block flex-shrink-0" style={{ width: 10, height: 10, borderRadius: 2, background: PALETTE[d.kind] }} />
            <span className="truncate" style={{ color: 'var(--rl-ink)', flex: 1 }}>{d.label}</span>
            <span className="font-mono text-[10px] w-8 text-right" style={{ color: 'var(--rl-ink-2)' }}>{d.count}</span>
            <span className="font-mono text-[10px] w-12 text-right" style={{ color: 'var(--rl-ink-3)' }}>{(d.count / total * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   BLOCK · LLM verify agreement (text + sparkbar)
   ============================================================ */
function LlmAgreementBlock({ llm }) {
  return (
    <div className="flex flex-col gap-3 py-1">
      <AgreementRow label="Top-1 일치율" value={llm.phase3_phase4_agreement_top1} hint="Phase 3 draft 1위 == Phase 4 revised 1위" />
      <AgreementRow label="Top-3 일치율" value={llm.phase3_phase4_agreement_top3} hint="Phase 3 top3 ∩ Phase 4 top3" />
      <div className="grid grid-cols-2 gap-2 mt-1">
        <div className="hairline rounded p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>Ranking 유지</div>
          <div className="font-serif text-xl mt-0.5" style={{ color: 'var(--rl-teal)' }}>{llm.ranking_kept_count.toLocaleString()}</div>
        </div>
        <div className="hairline rounded p-2.5">
          <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>Ranking 재조정</div>
          <div className="font-serif text-xl mt-0.5" style={{ color: 'var(--rl-amber)' }}>{llm.ranking_changed_count.toLocaleString()}</div>
        </div>
      </div>
      <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--rl-ink-3)' }}>
        총 {llm.total_executions.toLocaleString()} executions · {llm.notes}
      </div>
    </div>
  );
}

function AgreementRow({ label, value, hint }) {
  const pct = (value * 100).toFixed(0);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium" style={{ color: 'var(--rl-ink)' }}>{label}</span>
        <span className="font-serif text-xl ml-auto" style={{ color: 'var(--rl-primary)' }}>{pct}<span className="text-xs">%</span></span>
      </div>
      <div className="h-2 rounded mt-1" style={{ background: 'var(--rl-bg-3)', overflow: 'hidden' }}>
        <div className="h-full rounded" style={{ width: `${pct}%`, background: 'var(--rl-primary)' }} />
      </div>
      <div className="text-[10px] mt-0.5" style={{ color: 'var(--rl-ink-3)' }}>{hint}</div>
    </div>
  );
}

/* ============================================================
   CHART · Guardrail bars (horizontal)
   ============================================================ */
function GuardrailBars({ guardrails }) {
  const labelMap = {
    dose_safety:       '용량 안전성',
    age_appropriate:   '연령 적합성',
    rare_flag:         '희귀질환 flag',
    contraindication:  '금기 약물·시술',
    drug_interaction:  '약물 상호작용',
    citation_check:    '인용 검증',
  };
  const colors = {
    dose_safety:       'var(--rl-critical)',
    age_appropriate:   'var(--rl-primary)',
    rare_flag:         'var(--rl-rare)',
    contraindication:  'var(--rl-critical)',
    drug_interaction:  'var(--rl-amber)',
    citation_check:    'var(--rl-teal)',
  };
  const entries = Object.entries(guardrails).sort((a, b) => b[1] - a[1]);
  const max = entries[0][1];
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map(([key, count]) => (
        <div key={key} className="flex items-center gap-2 text-[11px]"
             title={`${labelMap[key] || key} — Guardrail 잡힌 케이스 ${count}건`}>
          <span style={{ minWidth: 110, color: 'var(--rl-ink)' }}>{labelMap[key] || key}</span>
          <div className="flex-1 h-3 rounded" style={{ background: 'var(--rl-bg-3)', overflow: 'hidden' }}>
            <div className="h-full rounded" style={{ width: `${(count / max) * 100}%`, background: colors[key] || 'var(--rl-primary)', opacity: 0.85 }} />
          </div>
          <span className="font-mono text-[10px] w-8 text-right" style={{ color: colors[key] || 'var(--rl-ink-2)' }}>{count}</span>
        </div>
      ))}
      <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--rl-ink-3)' }}>
        Phase 4 Bedrock Sonnet · 6 guardrail × 잡힌 케이스 누적
      </div>
    </div>
  );
}
