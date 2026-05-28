import React, { useState } from 'react';
import { Stethoscope, AlertTriangle, FileText, Users, LogIn, Image, TrendingUp, ChevronRight, ChevronLeft, Activity, Microscope, Zap, CheckCircle2, XCircle, Clock, ArrowUpRight, Flame, User, Calendar, Pill, FlaskConical } from 'lucide-react';

export default function RareLinkDesignSystem({ onBack }) {
  const [activeTab, setActiveTab] = useState('tokens');

  return (
    <div className="min-h-screen bg-slate-50" style={{ fontFamily: "'IBM Plex Sans', 'IBM Plex Sans KR', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

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

          --rl-support:       #0E8574;
          --rl-refute:        #C2410C;
        }

        .font-serif { font-family: 'IBM Plex Serif', Georgia, serif; }
        .font-mono  { font-family: 'IBM Plex Mono', monospace; }

        .hairline { border: 1px solid var(--rl-border-soft); }
        .hairline-strong { border: 1px solid var(--rl-border); }

        .grid-bg {
          background-image:
            linear-gradient(var(--rl-border-soft) 1px, transparent 1px),
            linear-gradient(90deg, var(--rl-border-soft) 1px, transparent 1px);
          background-size: 24px 24px;
        }

        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.35; }
        }
        .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }

        .chip {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 4px;
          font-size: 11px; font-weight: 500;
          letter-spacing: 0.02em;
        }
      `}</style>

      {/* ============ HEADER ============ */}
      <header className="hairline bg-white sticky top-0 z-50" style={{ borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}>
        <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium hairline-strong transition hover:bg-slate-50"
                style={{ color: 'var(--rl-primary)' }}
                title="설정으로 돌아가기"
              >
                <ChevronLeft size={13} /> 설정으로
              </button>
            )}
            <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: 'var(--rl-primary)' }}>
              <Stethoscope size={16} color="white" strokeWidth={2.5} />
            </div>
            <div>
              <div className="font-serif text-lg leading-none" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>
                Soo-<span style={{ fontStyle: 'italic', fontWeight: 500 }}>Pul</span>
              </div>
              <div className="font-mono text-[10px] mt-0.5 uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
                Design System · v0.1 · 2026.04.23
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 text-sm">
            {['tokens', 'typography', 'components', 'patterns', 'screens'].map(t => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className="capitalize transition"
                style={{
                  color: activeTab === t ? 'var(--rl-primary)' : 'var(--rl-ink-3)',
                  fontWeight: activeTab === t ? 600 : 400,
                  borderBottom: activeTab === t ? '2px solid var(--rl-primary)' : '2px solid transparent',
                  paddingBottom: '2px'
                }}
              >{t}</button>
            ))}
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-8 py-12">

        {/* ============ HERO ============ */}
        <section className="mb-20">
          <div className="flex items-baseline gap-4 mb-3">
            <div className="font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
              SKKU AWS SAY 2기 · 2팀 · Final Week 1
            </div>
            <div className="h-px flex-1" style={{ background: 'var(--rl-border-soft)' }} />
            <div className="font-mono text-xs" style={{ color: 'var(--rl-ink-3)' }}>
              박성수 · Frontend Lead
            </div>
          </div>
          <h1 className="font-serif text-5xl leading-tight mb-4" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.02em' }}>
            의사가 <span style={{ fontStyle: 'italic' }}>이미 아는</span> 언어로<br/>
            희귀 폐질환의 <span style={{ color: 'var(--rl-primary)' }}>Differential</span>을 보여주다
          </h1>
          <p className="text-base max-w-2xl leading-relaxed" style={{ color: 'var(--rl-ink-2)' }}>
            Epic·BESTCare의 레이아웃 문법, PACS의 영상 판독 습관, LIRICAL의 LR 시각화를 계승한 임상 의사결정 지원 인터페이스. Robinson et al. <span className="font-serif italic">Am J Hum Genet</span> 2020의 시각 패턴을 직접 차용하며, EU AI Act Article 22의 human-in-the-loop 요구를 UI 기본값으로 내재화합니다.
          </p>
        </section>

        {/* ============ TOKENS SECTION ============ */}
        {activeTab === 'tokens' && (
          <div className="space-y-16">

            {/* Color palette */}
            <section>
              <SectionHeader num="01" title="Color Tokens" subtitle="임상 신뢰도를 우선하는 저채도 컬러. 경고·희귀질환은 의미론적으로 구분." />

              <div className="grid grid-cols-4 gap-4 mb-8">
                <SwatchGroup
                  label="Primary"
                  desc="BRAND · TRUST"
                  swatches={[
                    { name: 'primary-dark', hex: '#083158', token: '--rl-primary-dark' },
                    { name: 'primary',      hex: '#0C447C', token: '--rl-primary', main: true },
                    { name: 'primary-2',    hex: '#1D5FAB', token: '--rl-primary-2' },
                    { name: 'primary-soft', hex: '#EFF4FB', token: '--rl-primary-soft' },
                  ]}
                />
                <SwatchGroup
                  label="Semantic"
                  desc="SUPPORT · REFUTE"
                  swatches={[
                    { name: 'teal',      hex: '#0E8574', token: '--rl-teal',      main: true, note: 'LR 지지' },
                    { name: 'teal-soft', hex: '#E6F5F2', token: '--rl-teal-soft' },
                    { name: 'critical',  hex: '#A32D2D', token: '--rl-critical',  main: true, note: 'LR 반박' },
                    { name: 'crit-soft', hex: '#FEE4E4', token: '--rl-critical-soft' },
                  ]}
                />
                <SwatchGroup
                  label="Flag"
                  desc="DON'T MISS · RARE"
                  swatches={[
                    { name: 'amber',      hex: '#B45309', token: '--rl-amber',      main: true, note: "Don't miss" },
                    { name: 'amber-soft', hex: '#FEF3C7', token: '--rl-amber-soft' },
                    { name: 'rare',       hex: '#6B21A8', token: '--rl-rare',       main: true, note: '희귀질환' },
                    { name: 'rare-soft',  hex: '#F3E8FF', token: '--rl-rare-soft' },
                  ]}
                />
                <SwatchGroup
                  label="Neutrals"
                  desc="INK · SURFACE"
                  swatches={[
                    { name: 'ink',       hex: '#0A1628', token: '--rl-ink', main: true },
                    { name: 'ink-2',     hex: '#334155', token: '--rl-ink-2' },
                    { name: 'border',    hex: '#CBD5E1', token: '--rl-border' },
                    { name: 'bg-2',      hex: '#F8FAFC', token: '--rl-bg-2' },
                  ]}
                />
              </div>

              <div className="hairline rounded bg-white p-6">
                <div className="font-mono text-[10px] uppercase tracking-widest mb-3" style={{ color: 'var(--rl-ink-3)' }}>Clinical Meaning Map</div>
                <div className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm">
                  <TokenRow c="var(--rl-primary)"  label="Primary actions · 브랜드 · 환자 배너 강조" />
                  <TokenRow c="var(--rl-teal)"     label="LR 지지 소견 · 정상 수치 · 확정 액션" />
                  <TokenRow c="var(--rl-critical)" label="LR 반박 소견 · 심각 이상치 · 삭제/기각" />
                  <TokenRow c="var(--rl-amber)"    label="Don't miss 플래그 · 주의 · 추가검사 필요" />
                  <TokenRow c="var(--rl-rare)"     label="희귀질환 배지 · Orphadata 연결 항목" />
                  <TokenRow c="var(--rl-ink-3)"    label="보조 텍스트 · 메타 정보 · 타임스탬프" />
                </div>
              </div>
            </section>

            {/* Spacing & Radius */}
            <section>
              <SectionHeader num="02" title="Spacing · Radius · Elevation" subtitle="EMR 전통: 정보 밀도 높음. 여백은 인색, 구분선은 얇고 분명." />

              <div className="grid grid-cols-2 gap-8">
                <div className="hairline rounded bg-white p-6">
                  <div className="font-mono text-[10px] uppercase tracking-widest mb-4" style={{ color: 'var(--rl-ink-3)' }}>Spacing Scale · 4px base</div>
                  {[
                    { t: '4px',  l: 'xs', u: '간격 · 아이콘↔텍스트' },
                    { t: '8px',  l: 'sm', u: '칩·뱃지 내부 패딩' },
                    { t: '12px', l: 'md', u: '버튼·카드 내부' },
                    { t: '16px', l: 'lg', u: '카드간 간격' },
                    { t: '24px', l: 'xl', u: '섹션간 간격' },
                    { t: '40px', l: '2xl',u: '페이지 블록 분리' },
                  ].map(s => (
                    <div key={s.t} className="flex items-center gap-4 py-2" style={{ borderBottom: '1px dashed var(--rl-border-soft)' }}>
                      <div className="font-mono text-xs w-12" style={{ color: 'var(--rl-ink-2)' }}>{s.t}</div>
                      <div className="font-mono text-xs w-10" style={{ color: 'var(--rl-primary)' }}>{s.l}</div>
                      <div style={{ height: '6px', width: s.t, background: 'var(--rl-primary)' }} />
                      <div className="text-xs ml-auto" style={{ color: 'var(--rl-ink-3)' }}>{s.u}</div>
                    </div>
                  ))}
                </div>

                <div className="hairline rounded bg-white p-6">
                  <div className="font-mono text-[10px] uppercase tracking-widest mb-4" style={{ color: 'var(--rl-ink-3)' }}>Radius · Elevation</div>
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    {[
                      { r: 2, l: 'sm',   u: '칩·입력' },
                      { r: 4, l: 'md',   u: '카드' },
                      { r: 8, l: 'lg',   u: '모달' },
                    ].map(r => (
                      <div key={r.l} className="flex flex-col items-center gap-2">
                        <div className="w-full h-16 hairline-strong bg-white" style={{ borderRadius: r.r + 'px' }} />
                        <div className="font-mono text-xs" style={{ color: 'var(--rl-ink-2)' }}>{r.r}px · {r.l}</div>
                        <div className="text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{r.u}</div>
                      </div>
                    ))}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-widest mb-3" style={{ color: 'var(--rl-ink-3)' }}>Elevation (restrained)</div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-3 bg-white rounded" style={{ boxShadow: '0 1px 2px rgba(10,22,40,0.06)' }}>
                      <div className="text-xs" style={{ color: 'var(--rl-ink-2)' }}>e1 · card</div>
                      <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>0 1 2 rgba(ink, 6%)</div>
                    </div>
                    <div className="p-3 bg-white rounded" style={{ boxShadow: '0 8px 24px rgba(10,22,40,0.10)' }}>
                      <div className="text-xs" style={{ color: 'var(--rl-ink-2)' }}>e2 · modal</div>
                      <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>0 8 24 rgba(ink, 10%)</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ============ TYPOGRAPHY ============ */}
        {activeTab === 'typography' && (
          <div className="space-y-16">
            <section>
              <SectionHeader num="03" title="Typography" subtitle="IBM Plex 패밀리. 의료·과학 영역에 뿌리, 한글 지원 우수. 생성형 AI의 Inter/Roboto 상투 탈피." />

              <div className="grid grid-cols-3 gap-6 mb-10">
                <FontCard
                  fam="IBM Plex Serif"
                  role="Display"
                  use="히어로 · 섹션 제목 · 브랜드 수식"
                  sample="Differential"
                  italicSample="the silent ones"
                  fontStack="'IBM Plex Serif', Georgia, serif"
                />
                <FontCard
                  fam="IBM Plex Sans KR"
                  role="Body · UI"
                  use="본문 · 레이블 · 버튼 · 한글 전반"
                  sample="특발성 폐섬유증"
                  italicSample="Chronic interstitial lung disease"
                  fontStack="'IBM Plex Sans KR', sans-serif"
                />
                <FontCard
                  fam="IBM Plex Mono"
                  role="Data"
                  use="HPO ID · MRN · 수치 · 코드 · 타임스탬프"
                  sample="HP:0002094"
                  italicSample="ORPHA:2032"
                  fontStack="'IBM Plex Mono', monospace"
                />
              </div>

              <div className="hairline rounded bg-white p-8">
                <div className="font-mono text-[10px] uppercase tracking-widest mb-6" style={{ color: 'var(--rl-ink-3)' }}>Type Scale</div>
                <div className="space-y-4">
                  <TypeRow size="40px" wt="500" fam="serif" label="h1 · 히어로" text="환자 김○○의 Differential" />
                  <TypeRow size="28px" wt="500" fam="serif" label="h2 · 섹션" text="Idiopathic Pulmonary Fibrosis" />
                  <TypeRow size="20px" wt="600" fam="sans"  label="h3 · 카드 제목" text="감별진단 (428 → 30 → Top 5)" />
                  <TypeRow size="16px" wt="500" fam="sans"  label="body-lg · 본문 강조" text="HPO 기반 Likelihood Ratio 엔진" />
                  <TypeRow size="14px" wt="400" fam="sans"  label="body · 본문 기본" text="양측 하엽 망상음영과 기저 honeycombing 의심" />
                  <TypeRow size="12px" wt="500" fam="sans"  label="caption · 메타" text="마지막 업데이트 08:32 KST · 재계산 대기" />
                  <TypeRow size="11px" wt="500" fam="mono"  label="mono · 데이터" text="HP:0001217 · ORPHA:2032 · LR 8.2" />
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ============ COMPONENTS ============ */}
        {activeTab === 'components' && (
          <div className="space-y-16">
            <section>
              <SectionHeader num="04" title="Core Components" subtitle="PDF §4에서 식별된 핵심 UI 원자. EMR·PACS·CDSS 삼각 벤치마크 반영." />

              {/* Buttons */}
              <ComponentBlock label="Buttons" desc="위계: Primary (1개) · Secondary (다수) · Danger (기각)">
                <div className="flex gap-3 flex-wrap items-center">
                  <RLButton variant="primary" icon={<Zap size={14} />}>🔍 분석 실행</RLButton>
                  <RLButton variant="secondary">추가 검사 지시</RLButton>
                  <RLButton variant="ghost">취소</RLButton>
                  <RLButton variant="danger">기각 (False Positive)</RLButton>
                  <RLButton variant="primary" size="sm">확정</RLButton>
                </div>
              </ComponentBlock>

              {/* Badges */}
              <ComponentBlock label="Status Badges · 의미론 분리" desc="희귀질환·Don't miss·일반은 색과 아이콘으로 명확히 구분">
                <div className="flex gap-3 flex-wrap">
                  <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
                    <Flame size={11} /> 희귀질환 · RARE
                  </span>
                  <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
                    <AlertTriangle size={11} /> Don't miss
                  </span>
                  <span className="chip" style={{ background: 'var(--rl-critical-soft)', color: 'var(--rl-critical)' }}>
                    <Activity size={11} /> 위중 · CRITICAL
                  </span>
                  <span className="chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>
                    <CheckCircle2 size={11} /> 정상 범위
                  </span>
                  <span className="chip" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
                    <Microscope size={11} /> HPO 매핑
                  </span>
                  <span className="chip hairline-strong" style={{ background: 'white', color: 'var(--rl-ink-2)' }}>
                    <Clock size={11} /> 분석 대기
                  </span>
                </div>
              </ComponentBlock>

              {/* Patient Banner */}
              <ComponentBlock label="Patient Banner · 상단 고정 (sticky)" desc="PDF §4.3 원칙 5번: 스크롤해도 사라지지 않음. Streamlit에서 불가능했던 핵심이 React에서 해결">
                <PatientBanner />
              </ComponentBlock>

              {/* Disease Ranking Card */}
              <ComponentBlock label="Disease Ranking Card" desc="우측 패널의 핵심 원자. 확률·배지·프로그레스·상세 버튼">
                <div className="grid grid-cols-2 gap-3">
                  <DxCard rank={1} name="특발성 폐섬유증 (IPF)" prob={0.84} rare dontMiss orpha="ORPHA:2032" />
                  <DxCard rank={2} name="Sarcoidosis" prob={0.62} />
                  <DxCard rank={3} name="과민성 폐렴 (HP)" prob={0.41} />
                  <DxCard rank={4} name="Lymphangioleiomyomatosis" prob={0.14} rare dontMiss orpha="ORPHA:538" greyed />
                </div>
              </ComponentBlock>

              {/* LR Bar Preview */}
              <ComponentBlock label="LR Bar · LIRICAL 스타일 (Robinson 2020 Fig.2 차용)" desc="좌: 반박 (빨강) · 우: 지지 (녹색). 질환 상세 뷰 핵심">
                <LRBarPreview />
              </ComponentBlock>

              {/* HITL Banner */}
              <ComponentBlock label="Human-in-the-Loop Banner" desc="EU AI Act Art.22 대응. 모든 진단 결과 페이지에 기본 노출">
                <HITLBanner />
              </ComponentBlock>
            </section>
          </div>
        )}

        {/* ============ PATTERNS ============ */}
        {activeTab === 'patterns' && (
          <div className="space-y-16">
            <section>
              <SectionHeader num="05" title="Layout Patterns" subtitle="Epic·BESTCare의 3-분할 + 상단 배너 문법을 Soo-Pul 용도로 재해석" />

              <div className="hairline rounded overflow-hidden" style={{ background: 'var(--rl-bg-3)' }}>
                <div className="grid grid-bg" style={{ minHeight: 540 }}>
                  <div className="relative w-full h-full p-6">
                    {/* Top banner */}
                    <div className="rounded bg-white hairline-strong px-4 py-3 mb-2 flex items-center gap-4">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}><User size={14} /></div>
                      <div className="font-serif font-medium" style={{ color: 'var(--rl-ink)' }}>김○○</div>
                      <div className="text-xs" style={{ color: 'var(--rl-ink-2)' }}>M · 58세</div>
                      <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>MRN 20-145982</div>
                      <span className="chip" style={{ background: 'var(--rl-critical-soft)', color: 'var(--rl-critical)' }}>알러지 · Penicillin</span>
                      <div className="ml-auto text-xs" style={{ color: 'var(--rl-ink-3)' }}>주호소: 호흡곤란 3개월</div>
                    </div>

                    {/* 3-panel grid */}
                    <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 2fr 1.2fr', height: 'calc(100% - 60px)' }}>
                      <PanelMock label="LEFT · Input" items={['CXR Upload', 'HPO Symptoms', 'Lab Values', 'Run Analysis']} />
                      <PanelMock label="CENTER · CXR + Model Output" items={['CXR + Heatmap Overlay', 'DenseNet-121 14 labels', 'Opacity Slider · WW/WL']} highlight />
                      <PanelMock label="RIGHT · Differential" items={['428 → HPO filter → Top 5', 'Disease Card · Rank', "Don't miss · Rare", 'Click → Detail']} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-4">
                <RationaleCard
                  title="왜 3-Panel인가"
                  citation="Epic Hyperdrive · BESTCare 2.0"
                  body="국내외 상급종합병원 EMR이 공통적으로 좌(워크리스트)-중(메인)-우(보조) 구조를 공유. 의사 근육 기억에 이미 새겨진 위치를 깨지 않음."
                />
                <RationaleCard
                  title="왜 CXR을 중앙에 두는가"
                  citation="Infinitt PACS · Lunit INSIGHT"
                  body="PACS 관습: 영상이 가장 큰 뷰포트 점유. Heatmap overlay·WW/WL 슬라이더도 PACS 조작 문법 그대로."
                />
                <RationaleCard
                  title="왜 랭킹을 우측에 두는가"
                  citation="Isabel · LIRICAL"
                  body="CDSS 관습: 입력 → 결과 흐름. 의사가 왼손으로 입력하고 오른쪽으로 눈을 옮기는 자연스러운 F-패턴."
                />
              </div>
            </section>
          </div>
        )}

        {/* ============ SCREENS ============ */}
        {activeTab === 'screens' && (
          <div className="space-y-12">
            <section>
              <SectionHeader num="06" title="Screen Map · 9 Screens" subtitle="로그인 → 외래 환자 목록 → 워크스페이스 → 상세 → 리포트 → 이미지 확대 → 케이스 비교 → 히스토리 → 설정" />

              <div className="grid grid-cols-3 gap-4">
                {[
                  { num: '01', name: '로그인',           icon: <LogIn size={16} />,        core: true,  desc: 'SMART on FHIR SSO 시뮬레이션 · OAuth2 콜백' },
                  { num: '02', name: '당일 외래 환자 목록', icon: <Users size={16} />,        core: true,  desc: 'Worklist · 환자 스테이터스 · CXR 도착 알림' },
                  { num: '03', name: '진단 워크스페이스',   icon: <Stethoscope size={16} />,  core: true,  hero: true, desc: '3-Panel · PDF §4.1 핵심 화면' },
                  { num: '04', name: '질환 상세 (LR)',    icon: <TrendingUp size={16} />,   core: true,  hero: true, desc: 'LIRICAL 스타일 LR 막대 · 권장 검사 · 문헌' },
                  { num: '05', name: '이미지 확대 뷰어',    icon: <Image size={16} />,        core: true,  desc: 'PACS-style · WW/WL · 줌 · Heatmap 토글' },
                  { num: '06', name: '리포트 뷰어',        icon: <FileText size={16} />,     core: true,  desc: 'PDF-like · 인쇄 가능 · EMR write-back' },
                  { num: '07', name: '유사 케이스 비교',    icon: <Microscope size={16} />,   core: false, desc: 'RAG 기반 · PubMed · Orphanet 논문 링크' },
                  { num: '08', name: '진단 히스토리',      icon: <Calendar size={16} />,     core: false, desc: '환자별 타임라인 · 이전 판독 비교' },
                  { num: '09', name: '설정',              icon: <Pill size={16} />,         core: false, desc: '의사 프로필 · 알림 · 기관 설정' },
                ].map(s => (
                  <ScreenCard key={s.num} {...s} />
                ))}
              </div>

              <div className="mt-10 hairline rounded bg-white p-6">
                <div className="font-mono text-[10px] uppercase tracking-widest mb-4" style={{ color: 'var(--rl-ink-3)' }}>5-Week Construction Order</div>
                <div className="grid grid-cols-5 gap-2">
                  {[
                    { w: 'W1', dates: '04/20–04/26', scope: '디자인 시스템 ✓ · SMART 샌드박스 세팅' },
                    { w: 'W2', dates: '04/27–05/03', scope: '로그인 · 환자 목록 · 워크스페이스 정적' },
                    { w: 'W3', dates: '05/04–05/10', scope: 'SageMaker 연결 · LR 상세 · 이미지 뷰어' },
                    { w: 'W4', dates: '05/11–05/17', scope: 'Heatmap · RAG · 리포트 · 폴리싱' },
                    { w: 'W5', dates: '05/18–05/24', scope: '시나리오 · 녹화 · 발표 연동' },
                  ].map((w, i) => (
                    <div key={w.w} className="hairline rounded p-3" style={{ background: i === 0 ? 'var(--rl-primary-soft)' : 'white' }}>
                      <div className="font-mono text-[10px] uppercase" style={{ color: 'var(--rl-primary)' }}>{w.w}</div>
                      <div className="font-mono text-[10px] mt-0.5" style={{ color: 'var(--rl-ink-3)' }}>{w.dates}</div>
                      <div className="text-[11px] mt-2 leading-tight" style={{ color: 'var(--rl-ink-2)' }}>{w.scope}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        )}

        <footer className="mt-24 pt-8 hairline" style={{ borderBottom: 'none', borderLeft: 'none', borderRight: 'none' }}>
          <div className="flex items-baseline gap-3 font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>
            <span>Soo-Pul · Design System v0.1</span>
            <span>·</span>
            <span>계승 문서: Rare-Link-AI_UIUX_설계제안서.pdf (박성수, 2026-04-21)</span>
            <span>·</span>
            <span className="ml-auto">AWS SAY 2기 · 2팀 · Final Phase</span>
          </div>
        </footer>

      </div>
    </div>
  );
}

/* ============================ HELPERS ============================ */

function SectionHeader({ num, title, subtitle }) {
  return (
    <div className="mb-8">
      <div className="flex items-baseline gap-4 mb-1">
        <div className="font-mono text-xs" style={{ color: 'var(--rl-primary)' }}>{num}</div>
        <div className="h-px flex-1" style={{ background: 'var(--rl-border-soft)' }} />
      </div>
      <h2 className="font-serif text-3xl mb-2" style={{ color: 'var(--rl-ink)', letterSpacing: '-0.01em' }}>{title}</h2>
      <p className="text-sm max-w-2xl" style={{ color: 'var(--rl-ink-3)' }}>{subtitle}</p>
    </div>
  );
}

function SwatchGroup({ label, desc, swatches }) {
  return (
    <div className="hairline rounded bg-white p-4">
      <div className="mb-3">
        <div className="font-serif text-base" style={{ color: 'var(--rl-ink)' }}>{label}</div>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>{desc}</div>
      </div>
      {swatches.map(s => (
        <div key={s.name} className="mb-1.5">
          <div className="flex items-center gap-2 mb-0.5">
            <div className="w-8 h-8 rounded-sm hairline-strong" style={{ background: s.hex }} />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[11px] truncate" style={{ color: s.main ? 'var(--rl-ink)' : 'var(--rl-ink-2)', fontWeight: s.main ? 600 : 400 }}>
                {s.name}
              </div>
              <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{s.hex}</div>
            </div>
          </div>
          {s.note && <div className="text-[10px] ml-10" style={{ color: 'var(--rl-ink-3)' }}>→ {s.note}</div>}
        </div>
      ))}
    </div>
  );
}

function TokenRow({ c, label }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: c }} />
      <div style={{ color: 'var(--rl-ink-2)' }}>{label}</div>
    </div>
  );
}

function FontCard({ fam, role, use, sample, italicSample, fontStack }) {
  return (
    <div className="hairline rounded bg-white p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-primary)' }}>{role}</div>
        <div className="text-xs" style={{ color: 'var(--rl-ink-3)' }}>{fam}</div>
      </div>
      <div className="text-4xl leading-none mb-2" style={{ fontFamily: fontStack, color: 'var(--rl-ink)' }}>{sample}</div>
      <div className="text-base mb-4 italic" style={{ fontFamily: fontStack, color: 'var(--rl-ink-2)' }}>{italicSample}</div>
      <div className="text-xs pt-3" style={{ color: 'var(--rl-ink-3)', borderTop: '1px solid var(--rl-border-soft)' }}>
        {use}
      </div>
    </div>
  );
}

function TypeRow({ size, wt, fam, label, text }) {
  const family = fam === 'serif' ? "'IBM Plex Serif', serif" : fam === 'mono' ? "'IBM Plex Mono', monospace" : "'IBM Plex Sans KR', sans-serif";
  return (
    <div className="flex items-baseline gap-6 pb-3" style={{ borderBottom: '1px dashed var(--rl-border-soft)' }}>
      <div className="w-32 flex-shrink-0">
        <div className="font-mono text-[11px]" style={{ color: 'var(--rl-primary)' }}>{label}</div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{size} · {wt} · {fam}</div>
      </div>
      <div style={{ fontFamily: family, fontSize: size, fontWeight: wt, color: 'var(--rl-ink)', lineHeight: 1.2 }}>{text}</div>
    </div>
  );
}

function ComponentBlock({ label, desc, children }) {
  return (
    <div className="mb-10">
      <div className="mb-4">
        <div className="flex items-baseline gap-3">
          <div className="font-serif text-lg" style={{ color: 'var(--rl-ink)' }}>{label}</div>
          <div className="h-px flex-1 max-w-xs" style={{ background: 'var(--rl-border-soft)' }} />
        </div>
        <div className="text-xs mt-1" style={{ color: 'var(--rl-ink-3)' }}>{desc}</div>
      </div>
      <div className="hairline rounded bg-white p-6">
        {children}
      </div>
    </div>
  );
}

function RLButton({ variant = 'primary', size = 'md', icon, children }) {
  const base = { primary: { bg: 'var(--rl-primary)', c: 'white', bd: 'var(--rl-primary)' },
                 secondary: { bg: 'white', c: 'var(--rl-primary)', bd: 'var(--rl-primary)' },
                 ghost: { bg: 'transparent', c: 'var(--rl-ink-2)', bd: 'transparent' },
                 danger: { bg: 'white', c: 'var(--rl-critical)', bd: 'var(--rl-critical)' } }[variant];
  const pad = size === 'sm' ? '6px 12px' : '9px 16px';
  return (
    <button
      className="rounded inline-flex items-center gap-2 text-sm transition hover:opacity-90"
      style={{ background: base.bg, color: base.c, border: `1px solid ${base.bd}`, padding: pad, fontWeight: 500 }}
    >
      {icon}{children}
    </button>
  );
}

function PatientBanner() {
  return (
    <div className="hairline-strong rounded bg-white flex items-center gap-4 px-4 py-3">
      <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
        <User size={18} />
      </div>
      <div>
        <div className="font-serif text-lg leading-none" style={{ color: 'var(--rl-ink)' }}>김○○</div>
        <div className="text-[11px] mt-1" style={{ color: 'var(--rl-ink-3)' }}>M · 58세 · 외래 초진</div>
      </div>
      <div className="ml-2 pl-4" style={{ borderLeft: '1px solid var(--rl-border)' }}>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>MRN</div>
        <div className="font-mono text-sm" style={{ color: 'var(--rl-ink)' }}>20-145982</div>
      </div>
      <div className="pl-4" style={{ borderLeft: '1px solid var(--rl-border)' }}>
        <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>주호소</div>
        <div className="text-sm" style={{ color: 'var(--rl-ink)' }}>호흡곤란 3개월 · 마른기침</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="chip" style={{ background: 'var(--rl-critical-soft)', color: 'var(--rl-critical)' }}>
          <AlertTriangle size={11} /> Penicillin 알러지
        </span>
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>
          <span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--rl-teal)' }} />
          FHIR sync 08:32
        </div>
      </div>
    </div>
  );
}

function DxCard({ rank, name, prob, rare, dontMiss, orpha, greyed }) {
  const bar = prob * 100;
  return (
    <div className="hairline-strong rounded bg-white p-3" style={{ opacity: greyed ? 0.6 : 1, borderLeft: dontMiss ? '3px solid var(--rl-amber)' : undefined }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="font-mono text-[11px] flex-shrink-0" style={{ color: 'var(--rl-ink-3)' }}>#{rank}</div>
          <div className="text-sm font-medium leading-tight truncate" style={{ color: 'var(--rl-ink)' }}>{name}</div>
        </div>
        <div className="font-serif text-lg leading-none flex-shrink-0" style={{ color: 'var(--rl-primary)' }}>{(prob * 100).toFixed(0)}<span className="text-xs">%</span></div>
      </div>
      <div className="h-1.5 rounded-full mb-2" style={{ background: 'var(--rl-bg-3)' }}>
        <div className="h-full rounded-full" style={{ width: bar + '%', background: 'var(--rl-primary)' }} />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {rare && (
          <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
            <Flame size={10} /> 희귀
          </span>
        )}
        {dontMiss && (
          <span className="chip" style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)' }}>
            <AlertTriangle size={10} /> Don't miss
          </span>
        )}
        {orpha && <span className="font-mono text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>{orpha}</span>}
        <button className="ml-auto flex items-center gap-0.5 text-[11px]" style={{ color: 'var(--rl-primary)' }}>
          상세 <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function LRBarPreview() {
  const features = [
    { name: 'Reticular pattern (CXR)', lr: 8.2,  side: 'support', hpo: '' },
    { name: 'KL-6 elevation',          lr: 5.1,  side: 'support', hpo: '' },
    { name: 'Clubbing',                lr: 3.4,  side: 'support', hpo: 'HP:0001217' },
    { name: 'Age > 50',                lr: 2.8,  side: 'support', hpo: '' },
    { name: 'Chronic cough',           lr: 1.4,  side: 'support', hpo: 'HP:0004469' },
    { name: 'No honeycombing yet',     lr: -0.3, side: 'refute',  hpo: '' },
    { name: 'CRP 2.1 (low-grade)',     lr: -0.5, side: 'refute',  hpo: '' },
  ];
  const max = 10;
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-3">
        <div className="font-serif text-lg" style={{ color: 'var(--rl-ink)' }}>특발성 폐섬유증 (IPF)</div>
        <div className="font-mono text-[11px]" style={{ color: 'var(--rl-ink-3)' }}>ORPHA:2032 · J84.112</div>
        <span className="chip" style={{ background: 'var(--rl-rare-soft)', color: 'var(--rl-rare)' }}>
          <Flame size={10} /> RARE
        </span>
        <div className="ml-auto">
          <span className="font-mono text-[10px] uppercase tracking-widest mr-1" style={{ color: 'var(--rl-ink-3)' }}>Post-test P</span>
          <span className="font-serif text-xl" style={{ color: 'var(--rl-primary)' }}>84%</span>
        </div>
      </div>

      <div className="relative" style={{ paddingLeft: '40%', paddingRight: '40%' }}>
        {features.map((f, i) => {
          const isSupport = f.side === 'support';
          const width = Math.abs(f.lr) / max * 100;
          return (
            <div key={i} className="flex items-center my-1.5 relative">
              <div className="absolute left-0 right-0 top-1/2 pointer-events-none" style={{ height: 1, background: 'var(--rl-border-soft)', transform: 'translateY(-50%)' }} />
              <div className="absolute top-0 bottom-0 w-px" style={{ left: '50%', background: 'var(--rl-ink-2)' }} />
              <div className="absolute text-xs whitespace-nowrap" style={{ right: isSupport ? 'auto' : 'calc(50% + 8px)', left: isSupport ? 'calc(50% + 8px)' : 'auto', top: '50%', transform: 'translateY(-50%)', color: 'var(--rl-ink)', order: isSupport ? 2 : 1 }}>
                {isSupport ? f.name : ''}
              </div>
              {!isSupport && (
                <div className="absolute text-xs whitespace-nowrap" style={{ right: 'calc(50% + 8px)', top: '50%', transform: 'translateY(-50%)', color: 'var(--rl-ink)' }}>
                  {f.name}
                </div>
              )}
              <div className="absolute h-5 flex items-center" style={{
                left: isSupport ? '50%' : `calc(50% - ${width / 2}%)`,
                width: width / 2 + '%',
                background: isSupport ? 'var(--rl-support)' : 'var(--rl-refute)',
                top: '50%',
                transform: 'translateY(-50%)',
                borderRadius: '2px'
              }}>
                <div className="font-mono text-[10px] px-2" style={{ color: 'white', marginLeft: isSupport ? 'auto' : undefined }}>
                  LR {Math.abs(f.lr).toFixed(1)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 text-[11px] font-mono uppercase tracking-widest" style={{ borderTop: '1px dashed var(--rl-border-soft)', color: 'var(--rl-ink-3)' }}>
        <span style={{ color: 'var(--rl-refute)' }}>← REFUTE</span>
        <span>Robinson et al. Am J Hum Genet 2020 · Fig.2 직접 차용</span>
        <span style={{ color: 'var(--rl-support)' }}>SUPPORT →</span>
      </div>
    </div>
  );
}

function HITLBanner() {
  return (
    <div className="rounded p-4 flex items-start gap-3" style={{ background: 'var(--rl-amber-soft)', border: '1px solid var(--rl-amber)' }}>
      <AlertTriangle size={20} style={{ color: 'var(--rl-amber)', flexShrink: 0, marginTop: 1 }} />
      <div className="flex-1">
        <div className="font-medium text-sm mb-1" style={{ color: 'var(--rl-amber)' }}>
          본 결과는 진단 보조용이며 의사의 최종 판단이 필요합니다
        </div>
        <div className="text-xs" style={{ color: 'var(--rl-ink-2)' }}>
          This tool is a research/educational prototype and not yet cleared as SaMD. 모든 AI 출력은 주치의의 검토를 거쳐야 하며, 치료 결정의 근거로 단독 사용되어서는 안 됩니다.
          <span className="font-mono ml-2" style={{ color: 'var(--rl-ink-3)' }}>[EU AI Act Art. 22 · FDA SaMD Framework]</span>
        </div>
      </div>
    </div>
  );
}

function PanelMock({ label, items, highlight }) {
  return (
    <div className="rounded bg-white hairline-strong p-3 flex flex-col gap-2" style={{ background: highlight ? '#FAFCFF' : 'white' }}>
      <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: highlight ? 'var(--rl-primary)' : 'var(--rl-ink-3)' }}>{label}</div>
      {items.map((it, i) => (
        <div key={i} className="rounded px-2 py-2 text-[11px]" style={{ background: 'var(--rl-bg-3)', color: 'var(--rl-ink-2)' }}>
          {it}
        </div>
      ))}
    </div>
  );
}

function RationaleCard({ title, citation, body }) {
  return (
    <div className="hairline rounded bg-white p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--rl-primary)' }}>{citation}</div>
      <div className="font-serif text-base mb-2" style={{ color: 'var(--rl-ink)' }}>{title}</div>
      <div className="text-xs leading-relaxed" style={{ color: 'var(--rl-ink-2)' }}>{body}</div>
    </div>
  );
}

function ScreenCard({ num, name, icon, desc, core, hero }) {
  return (
    <div className="hairline rounded bg-white p-5 relative" style={{ borderLeft: hero ? '3px solid var(--rl-primary)' : undefined }}>
      <div className="flex items-baseline justify-between mb-3">
        <div className="font-mono text-xs" style={{ color: 'var(--rl-primary)' }}>{num}</div>
        <div className="flex items-center gap-2">
          {hero && <span className="chip" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>HERO</span>}
          {core ? (
            <span className="chip" style={{ background: 'var(--rl-teal-soft)', color: 'var(--rl-teal)' }}>CORE</span>
          ) : (
            <span className="chip hairline-strong" style={{ color: 'var(--rl-ink-3)' }}>OPT</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: 'var(--rl-primary-soft)', color: 'var(--rl-primary)' }}>
          {icon}
        </div>
        <div className="font-serif text-base" style={{ color: 'var(--rl-ink)' }}>{name}</div>
      </div>
      <div className="text-xs leading-relaxed" style={{ color: 'var(--rl-ink-3)' }}>{desc}</div>
    </div>
  );
}
