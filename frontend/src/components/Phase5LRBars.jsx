/* ============================================================
   Phase5LRBars · Robinson 2020 Fig.2 LR 막대 시각화
   ============================================================
   근거: Robinson PN et al. Am J Hum Genet 2020;107:403-417 Fig.2
        — phenotype-driven prioritization 의 log-LR 가로막대.

   Props:
     - diseases:      Phase5Result.listed_diseases (LR 내림차순)
     - topN:          렌더할 상위 N (default 5)
     - showEvidence:  evidence 분해 (radiology/symptoms/lab/micro) 표시
     - expanded:      처음 펼친 카드 index (default 0)

   Source: backend.sessions.result(id).phase5 또는 dx.session.phase5
   ============================================================ */
import React, { useState } from 'react';
import { ChevronDown, ChevronUp, AlertTriangle, Dna, Activity } from 'lucide-react';

const MODALITIES = [
  { key: 'log_lr_radiology', label: 'Radiology', short: 'CXR' },
  { key: 'log_lr_symptoms',  label: 'Symptoms',  short: 'HPO' },
  { key: 'log_lr_lab',       label: 'Lab',       short: 'LAB' },
  { key: 'log_lr_micro',     label: 'Micro',     short: 'MIC' },
];

const LR_CATEGORY_LABEL = {
  A: '확정 시사', B: '강력 시사', C: '시사', D: '약한 시사',
  E: '비특이', F: '반박 가능', G: '강한 반박',
};

export default function Phase5LRBars({ diseases = [], topN = 5, showEvidence = true, expandedDefault = 0 }) {
  if (!Array.isArray(diseases) || diseases.length === 0) {
    return (
      <div
        className="hairline rounded p-4 text-[12px]"
        style={{ background: 'var(--rl-bg-2)', color: 'var(--rl-ink-3)' }}
      >
        희귀질환 후보 없음 (LR &gt; 5 만족하는 질환 검출 안 됨)
      </div>
    );
  }

  const shown = diseases.slice(0, topN);
  return (
    <div className="flex flex-col gap-2">
      {shown.map((d, i) => (
        <DiseaseCard
          key={d.orphacode || i}
          disease={d}
          rank={i + 1}
          startExpanded={i === expandedDefault}
          showEvidence={showEvidence}
        />
      ))}
      {diseases.length > topN && (
        <div className="text-[10px] font-mono px-2 py-1" style={{ color: 'var(--rl-ink-3)' }}>
          +{diseases.length - topN} 개 후보 (전체 {diseases.length}개)
        </div>
      )}
    </div>
  );
}

function DiseaseCard({ disease, rank, startExpanded, showEvidence }) {
  const [open, setOpen] = useState(!!startExpanded);
  const d = disease || {};
  const lr = d.lr_value ?? 0;
  const cat = d.lr_category;
  const isStrong = lr >= 100;       // LR ≥ 100 = strong evidence
  const isModerate = lr >= 5 && lr < 100;

  // Don't miss 후보: lr_category A 또는 LR > 50
  const dontMiss = cat === 'A' || lr > 50;

  return (
    <div
      className="hairline rounded"
      style={{
        background: 'white',
        borderColor: dontMiss ? 'var(--rl-amber)' : undefined,
        boxShadow: dontMiss ? '0 0 0 1px var(--rl-amber-soft) inset' : undefined,
      }}
    >
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition hover:opacity-90"
      >
        <span
          className="font-mono text-[11px] flex-shrink-0 w-6 text-center"
          style={{ color: 'var(--rl-ink-3)' }}
        >
          #{rank}
        </span>
        <span className="flex-1 min-w-0">
          <span className="font-medium text-[13px] block truncate" style={{ color: 'var(--rl-ink)' }}>
            {d.disease_kr || d.disease_en || '(이름 없음)'}
            {d.disease_kr && d.disease_en && (
              <span className="ml-2 text-[10px] font-normal" lang="en" style={{ color: 'var(--rl-ink-3)' }}>
                {d.disease_en}
              </span>
            )}
          </span>
          <span className="font-mono text-[10px] block" style={{ color: 'var(--rl-ink-3)' }}>
            {d.orphacode}{d.icd10?.length ? ` · ICD-10 ${d.icd10[0]}` : ''}{d.prevalence ? ` · ${d.prevalence}` : ''}
          </span>
        </span>
        <LRBadge lr={lr} category={cat} />
        {dontMiss && (
          <span
            className="hairline rounded-full px-1.5 py-0.5 text-[9px] font-mono flex items-center gap-0.5"
            style={{ background: 'var(--rl-amber-soft)', color: 'var(--rl-amber)', borderColor: 'var(--rl-amber)' }}
            title="Don't miss · 위중 희귀질환"
          >
            <AlertTriangle size={9} /> DON&apos;T MISS
          </span>
        )}
        {open ? <ChevronUp size={14} style={{ color: 'var(--rl-ink-3)' }} /> : <ChevronDown size={14} style={{ color: 'var(--rl-ink-3)' }} />}
      </button>

      {/* Body */}
      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3" style={{ borderTop: '1px solid var(--rl-border-soft)' }}>
          {/* LR 분해 막대 (Robinson Fig.2) */}
          {showEvidence && d.evidence && (
            <EvidenceBars evidence={d.evidence} category={cat} />
          )}

          {/* matched + contradicted HPO 한 줄 요약 */}
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <MatchedColumn
              title="지지 (matched)"
              groups={[
                ['CXR',   d.matched_hpo_phase2],
                ['증상',  d.matched_hpo_phase1],
                ['Lab',   d.matched_hpo_lab],
              ]}
              positive
            />
            <MatchedColumn
              title="반박 (contradicted)"
              groups={[['전체', d.contradicted_hpo]]}
              positive={false}
            />
          </div>

          {/* Gene / inheritance */}
          {(d.gene_associations?.length || d.inheritance?.length) ? (
            <div className="flex items-center gap-3 text-[10px] font-mono" style={{ color: 'var(--rl-ink-3)' }}>
              {d.gene_associations?.length > 0 && (
                <span className="flex items-center gap-1">
                  <Dna size={10} style={{ color: 'var(--rl-rare)' }} />
                  {d.gene_associations.slice(0, 4).join(', ')}
                  {d.gene_associations.length > 4 ? ` +${d.gene_associations.length - 4}` : ''}
                </span>
              )}
              {d.inheritance?.length > 0 && (
                <span className="flex items-center gap-1">
                  <Activity size={10} />
                  {d.inheritance.join(' · ')}
                </span>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function LRBadge({ lr, category }) {
  const display = lr >= 1
    ? (lr >= 100 ? `${lr.toFixed(0)}` : lr.toFixed(1))
    : lr.toFixed(2);
  const color = lr >= 100 ? 'var(--rl-teal)'
              : lr >= 5   ? 'var(--rl-teal)'
              : lr <= 0.2 ? 'var(--rl-critical)'
              :             'var(--rl-ink-3)';
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className="font-mono text-[14px] font-medium" style={{ color }}>
        LR {display}
      </span>
      {category && (
        <span
          className="font-mono text-[9px] uppercase tracking-wider"
          style={{ color: 'var(--rl-ink-3)' }}
          title={LR_CATEGORY_LABEL[category] || ''}
        >
          {category} · {LR_CATEGORY_LABEL[category] || ''}
        </span>
      )}
    </span>
  );
}

/**
 * EvidenceBars — 4 modality + 가중치 합 + prior 한꺼번에.
 * 0 중심선, 양수 우측 (지지 · teal), 음수 좌측 (반박 · critical).
 * 막대 길이는 |log_lr| / MAX_LOG_LR 비율.
 */
function EvidenceBars({ evidence, category }) {
  const values = MODALITIES.map(m => ({ ...m, value: Number(evidence[m.key] ?? 0) }));
  const summary = [
    { key: 'weighted_log_lr', label: 'Weighted', short: 'WGT', value: Number(evidence.weighted_log_lr ?? 0) },
    { key: 'log_prior',       label: 'Prior',    short: 'PRI', value: Number(evidence.log_prior ?? 0) },
    { key: 'final_score',     label: 'Final',    short: 'FIN', value: Number(evidence.final_score ?? 0) },
  ];

  // 막대 스케일: 4 modality + summary 의 |value| 최댓값. 최소 1.0 보장.
  const allVals = [...values, ...summary].map(v => Math.abs(v.value));
  const max = Math.max(1.0, ...allVals);

  return (
    <div className="rounded p-2" style={{ background: 'var(--rl-bg-2)' }}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--rl-ink-3)' }}>
          Log-LR 분해
        </span>
        <span className="text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>
          (Robinson 2020 Fig.2 · log<sub>10</sub> scale)
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {values.map(v => <BarRow key={v.key} {...v} max={max} />)}
        <div style={{ height: 4 }} />
        {summary.map(v => <BarRow key={v.key} {...v} max={max} subtle />)}
      </div>
    </div>
  );
}

function BarRow({ short, label, value, max, subtle }) {
  const pct = Math.min(100, (Math.abs(value) / max) * 50);  // 0 중심 → 절반씩
  const pos = value >= 0;
  const color = subtle ? 'var(--rl-ink-2)' : (pos ? 'var(--rl-teal)' : 'var(--rl-critical)');
  const valFmt = (value >= 0 ? '+' : '') + value.toFixed(2);

  return (
    <div className="flex items-center gap-2">
      <span
        className="font-mono text-[9px] w-8 text-right flex-shrink-0"
        style={{ color: 'var(--rl-ink-3)' }}
        title={label}
      >
        {short}
      </span>
      <div className="flex-1 relative" style={{ height: 12 }}>
        {/* 0 중심선 */}
        <div className="absolute top-0 bottom-0" style={{ left: '50%', width: 1, background: 'var(--rl-border-soft)' }} />
        {/* 막대 */}
        <div
          className="absolute top-1 bottom-1"
          style={{
            left:  pos ? '50%' : `calc(50% - ${pct}%)`,
            width: `${pct}%`,
            background: color,
            opacity: subtle ? 0.55 : 0.85,
            borderRadius: 1.5,
          }}
        />
      </div>
      <span
        className="font-mono text-[10px] w-12 text-right flex-shrink-0"
        style={{ color }}
      >
        {valFmt}
      </span>
    </div>
  );
}

function MatchedColumn({ title, groups, positive }) {
  const total = groups.reduce((acc, [, arr]) => acc + (arr?.length || 0), 0);
  const color = positive ? 'var(--rl-teal)' : 'var(--rl-critical)';
  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-widest mb-1 flex items-center gap-1"
        style={{ color }}
      >
        {title} · <span style={{ color: 'var(--rl-ink-3)' }}>{total}</span>
      </div>
      {total === 0 ? (
        <div className="text-[10px]" style={{ color: 'var(--rl-ink-3)' }}>—</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {groups.map(([gLabel, arr]) =>
            (arr?.length ?? 0) > 0 ? (
              <div key={gLabel} className="flex items-baseline gap-1 leading-tight">
                <span
                  className="font-mono text-[9px] flex-shrink-0 w-7"
                  style={{ color: 'var(--rl-ink-3)' }}
                >
                  {gLabel}
                </span>
                <span className="text-[11px] truncate" style={{ color: 'var(--rl-ink-2)' }}>
                  {arr.slice(0, 3).map(h => h.hpo_id || h).join(', ')}
                  {arr.length > 3 ? ` +${arr.length - 3}` : ''}
                </span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
