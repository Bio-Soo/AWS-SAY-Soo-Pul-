"""Phase 3 운영 경로 — Aurora DB cluster에 phase3_integrated_ranking 적재.

배경 (soopulai v4 alignment, 2026-05-14 + v3_6 schema 갱신, 2026-05-19)
═══════════════════════════════════════════════════════════════════
Phase 3 multimodal scoring 결과(`DiseaseScore` list + scoring_process)를
`soopulai.phase3_integrated_ranking` 테이블에 1 session = 1 row로 적재.

본 모듈은 *connection driver 선택*과 *JSONB serialization*만 정의.
boto3/psycopg2 등 DB 클라이언트 의존은 호출 측에서 주입 (의존성 격리,
aurora_reader.py 와 동일 패턴).

테이블 schema (정합 출처: docs/pipeline_io_examples/phase3_phase4_schema_v4.sql)
═══════════════════════════════════════════════════════════════════
CREATE TABLE soopulai.phase3_integrated_ranking (
  session_id              UUID         PRIMARY KEY,
  phase                   SMALLINT     NOT NULL DEFAULT 3,
  executed_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  unified_positive_hpo    JSONB        NOT NULL,
  lab_anomalies           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  lab_ref_ver             TEXT,
  modality_weights        JSONB        NOT NULL,
  thresholds_bonus_config JSONB        NOT NULL,
  yaml_ssot_ver           TEXT         NOT NULL,                 -- "v3_6"
  rare_db_ver             TEXT,
  excel_db_ver            TEXT,                                  -- "v9"
  scorer_code_sha         VARCHAR(40),
  evaluated_disease_count INT          NOT NULL DEFAULT 104,
  scoring                 JSONB        NOT NULL,
  ranking                 JSONB        NOT NULL,
  scoring_process         JSONB        NOT NULL,
  inference_time_ms       INT,
  input_data_meta         JSONB        NOT NULL DEFAULT '{}'::jsonb
);

v3_6 변경 사항 (2026-05-19)
═══════════════════════════════════════════════════════════════════
- yaml_ssot_ver: "v3_6" (sub_code_radiology_findings B 옵션 추가)
- excel_db_ver: "v9" (Q22 Congenital Heart Disease 제거)
- evaluated_disease_count DEFAULT 104 (이전 105, Q22 제거 후)
- scoring_process[*].evidence[*] 에 matched_sub_code + sub_code_authority 필드 포함 가능
  (DiagnosticEvidence.matched_sub_code/sub_code_authority — Tschopp ERS 2015 등 권위 출처 trace)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Optional, Protocol
from uuid import UUID, uuid4

from ..domain.disease import DiseaseScore, DiagnosticEvidence


# ─────────────────────────────────────────────────────────────────────
# Writer Protocol — 호출 측이 구현 (psycopg2 / boto3 RDS Data API 등)
# ─────────────────────────────────────────────────────────────────────


class Phase3WriterDataSource(Protocol):
    """Aurora DB INSERT 클라이언트 추상.

    구현체는 INSERT 실행 + commit 책임. 본 모듈은 SQL + 파라미터만 빌드.
    """

    def execute_insert(
        self,
        sql: str,
        params: dict[str, Any],
    ) -> None:
        """단일 INSERT 실행. SQL은 named placeholder 사용 (psycopg2 %(key)s 또는
        boto3 RDS Data API parameterSets 등 클라이언트 패턴에 맞게 변환).
        """
        ...


# ─────────────────────────────────────────────────────────────────────
# Phase 3 INSERT 행 빌더
# ─────────────────────────────────────────────────────────────────────


@dataclass
class Phase3WriteRow:
    """phase3_integrated_ranking 1 row 데이터 (JSONB serialization 전 raw)."""
    session_id: str                          # UUID 문자열
    executed_at: str                         # ISO 8601 timestamptz
    unified_positive_hpo: list[str]          # JSONB list[HP:ID]
    lab_anomalies: list[dict]                # JSONB array
    lab_ref_ver: str
    modality_weights: dict                   # disease_key → {S, L, R, M} 또는 default
    thresholds_bonus_config: dict            # W4(a-g) config
    yaml_ssot_ver: str                       # "v3_6"
    rare_db_ver: Optional[str]
    excel_db_ver: str                        # "v9"
    scorer_code_sha: Optional[str]
    evaluated_disease_count: int             # 104
    scoring: list[dict]                      # top-K disease score objects
    ranking: list[dict]                      # rank list
    scoring_process: list[dict]              # per-disease evidence + adjustments trace
    inference_time_ms: Optional[int]
    input_data_meta: dict


def _evidence_to_dict(ev: DiagnosticEvidence) -> dict:
    """DiagnosticEvidence → JSONB-serializable dict.

    v3_6: matched_sub_code/sub_code_authority 포함 (의학적 fact trace).
    """
    d = {
        "modality": ev.modality,
        "finding": ev.finding,
        "matched": ev.matched,
    }
    if ev.profile_criterion:
        d["profile_criterion"] = ev.profile_criterion
    if ev.weight > 0:
        d["weight"] = ev.weight
    if ev.detail:
        d["detail"] = ev.detail
    # v3_6: sub_code trace (B 옵션 활용 시)
    if ev.matched_sub_code:
        d["matched_sub_code"] = ev.matched_sub_code
    if ev.sub_code_authority:
        d["sub_code_authority"] = ev.sub_code_authority
    return d


def _score_to_jsonb_dict(score: DiseaseScore) -> dict:
    """DiseaseScore → scoring JSONB element."""
    return {
        "disease_key": score.disease_key,
        "name_en": score.name_en,
        "name_kr": score.name_kr,
        "category": score.category,
        "icd10": score.icd10_codes,
        "total_score": round(score.total_score, 4),
        "confidence": getattr(score.confidence, "value", str(score.confidence)),
        "modality_scores": {k: round(v, 3) for k, v in score.modality_scores.items()},
        "matched_count": score.matched_count,
        "total_criteria": getattr(score, "total_criteria", 0),
    }


def _score_to_ranking_dict(rank: int, score: DiseaseScore) -> dict:
    """DiseaseScore → ranking JSONB element."""
    return {
        "rank": rank,
        "disease_key": score.disease_key,
        "icd10": score.icd10_codes,
        "total_score": round(score.total_score, 4),
        "confidence": getattr(score.confidence, "value", str(score.confidence)),
    }


def _score_to_process_dict(score: DiseaseScore) -> dict:
    """DiseaseScore → scoring_process JSONB element (evidence + adjustments trace)."""
    return {
        "disease_key": score.disease_key,
        "evidence": [_evidence_to_dict(ev) for ev in score.evidence],
        # adjustments는 별도 trace (DiseaseScore에 adjustments 필드 있으면 직렬화)
        "adjustments": getattr(score, "adjustments", []),
    }


def build_write_row(
    *,
    session_id: str,
    ranked_scores: list[DiseaseScore],
    unified_positive_hpo: list[str],
    lab_anomalies: list[dict],
    modality_weights: dict,
    thresholds_bonus_config: dict,
    yaml_ssot_ver: str = "v3_6",
    excel_db_ver: str = "v9",
    evaluated_disease_count: int = 104,
    lab_ref_ver: str = "lab_v9_5",
    rare_db_ver: Optional[str] = None,
    scorer_code_sha: Optional[str] = None,
    inference_time_ms: Optional[int] = None,
    input_data_meta: Optional[dict] = None,
    executed_at: Optional[str] = None,
    top_k: int = 20,
) -> Phase3WriteRow:
    """Phase 3 scoring 결과 → Phase3WriteRow.

    Args:
        session_id: UUID (str) — Phase 1-5 전체 단일 식별자
        ranked_scores: DiseaseScore list (rank 순서)
        unified_positive_hpo: Phase 1 positive HPO IDs
        lab_anomalies: lab abnormality records
        modality_weights: disease_key → {S,L,R,M}
        thresholds_bonus_config: W4(a-g) config
        top_k: scoring 배열에 포함할 disease 수 (전체 ranked 중 상위 K)
    """
    if executed_at is None:
        executed_at = datetime.now(timezone.utc).isoformat()

    return Phase3WriteRow(
        session_id=session_id,
        executed_at=executed_at,
        unified_positive_hpo=list(unified_positive_hpo),
        lab_anomalies=list(lab_anomalies),
        lab_ref_ver=lab_ref_ver,
        modality_weights=dict(modality_weights),
        thresholds_bonus_config=dict(thresholds_bonus_config),
        yaml_ssot_ver=yaml_ssot_ver,
        rare_db_ver=rare_db_ver,
        excel_db_ver=excel_db_ver,
        scorer_code_sha=scorer_code_sha,
        evaluated_disease_count=evaluated_disease_count,
        scoring=[_score_to_jsonb_dict(s) for s in ranked_scores[:top_k]],
        ranking=[_score_to_ranking_dict(i + 1, s) for i, s in enumerate(ranked_scores[:top_k])],
        scoring_process=[_score_to_process_dict(s) for s in ranked_scores[:top_k]],
        inference_time_ms=inference_time_ms,
        input_data_meta=dict(input_data_meta or {}),
    )


# ─────────────────────────────────────────────────────────────────────
# SQL INSERT 빌더
# ─────────────────────────────────────────────────────────────────────


INSERT_SQL_TEMPLATE = """
INSERT INTO soopulai.phase3_integrated_ranking (
  session_id, executed_at,
  unified_positive_hpo, lab_anomalies, lab_ref_ver,
  modality_weights, thresholds_bonus_config,
  yaml_ssot_ver, rare_db_ver, excel_db_ver, scorer_code_sha,
  evaluated_disease_count,
  scoring, ranking, scoring_process,
  inference_time_ms, input_data_meta
) VALUES (
  %(session_id)s, %(executed_at)s,
  %(unified_positive_hpo)s::jsonb, %(lab_anomalies)s::jsonb, %(lab_ref_ver)s,
  %(modality_weights)s::jsonb, %(thresholds_bonus_config)s::jsonb,
  %(yaml_ssot_ver)s, %(rare_db_ver)s, %(excel_db_ver)s, %(scorer_code_sha)s,
  %(evaluated_disease_count)s,
  %(scoring)s::jsonb, %(ranking)s::jsonb, %(scoring_process)s::jsonb,
  %(inference_time_ms)s, %(input_data_meta)s::jsonb
);
"""


def build_insert_params(row: Phase3WriteRow) -> dict[str, Any]:
    """Phase3WriteRow → psycopg2 named-param dict (JSONB 컬럼은 json.dumps)."""
    return {
        "session_id": row.session_id,
        "executed_at": row.executed_at,
        "unified_positive_hpo": json.dumps(row.unified_positive_hpo, ensure_ascii=False),
        "lab_anomalies": json.dumps(row.lab_anomalies, ensure_ascii=False),
        "lab_ref_ver": row.lab_ref_ver,
        "modality_weights": json.dumps(row.modality_weights, ensure_ascii=False),
        "thresholds_bonus_config": json.dumps(row.thresholds_bonus_config, ensure_ascii=False),
        "yaml_ssot_ver": row.yaml_ssot_ver,
        "rare_db_ver": row.rare_db_ver,
        "excel_db_ver": row.excel_db_ver,
        "scorer_code_sha": row.scorer_code_sha,
        "evaluated_disease_count": row.evaluated_disease_count,
        "scoring": json.dumps(row.scoring, ensure_ascii=False),
        "ranking": json.dumps(row.ranking, ensure_ascii=False),
        "scoring_process": json.dumps(row.scoring_process, ensure_ascii=False),
        "inference_time_ms": row.inference_time_ms,
        "input_data_meta": json.dumps(row.input_data_meta, ensure_ascii=False),
    }


def write_row(
    source: Phase3WriterDataSource,
    row: Phase3WriteRow,
) -> dict[str, Any]:
    """Aurora DB에 1 row INSERT. SQL + params 반환 (dry-run 도구로도 사용 가능)."""
    params = build_insert_params(row)
    source.execute_insert(INSERT_SQL_TEMPLATE, params)
    return {"sql": INSERT_SQL_TEMPLATE, "params": params}


class DryRunWriter:
    """실제 DB 연결 없이 SQL + params만 캡처하는 driver (테스트/검증용)."""

    def __init__(self):
        self.executed: list[dict[str, Any]] = []

    def execute_insert(self, sql: str, params: dict[str, Any]) -> None:
        self.executed.append({"sql": sql, "params": params})


__all__ = [
    "Phase3WriterDataSource",
    "Phase3WriteRow",
    "build_write_row",
    "build_insert_params",
    "write_row",
    "DryRunWriter",
    "INSERT_SQL_TEMPLATE",
]
