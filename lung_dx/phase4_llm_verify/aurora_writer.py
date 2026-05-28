"""Phase 4 운영 경로 — Aurora DB cluster에 phase4_llm_rerank 적재.

배경 (soopulai v4 alignment, 2026-05-14)
═══════════════════════════════════════════════════════════════════
Phase 4 LLM rerank 결과(verifier.py 출력)를 `soopulai.phase4_llm_rerank`
테이블에 1 session = 1 row로 적재. Phase 3와 동일 session_id로 join.

설계: aurora_reader.py + phase3_multimodal/aurora_writer.py 와 동일
Protocol 패턴. boto3/psycopg2 의존은 호출 측이 주입.

테이블 schema (정합 출처: docs/pipeline_io_examples/phase3_phase4_schema_v4.sql)
═══════════════════════════════════════════════════════════════════
CREATE TABLE soopulai.phase4_llm_rerank (
  session_id              UUID         PRIMARY KEY,
  phase                   SMALLINT     NOT NULL DEFAULT 4,
  executed_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  p3_executed_at          TIMESTAMPTZ  NOT NULL,
  agrees_with_top1        BOOLEAN      NOT NULL,
  reranked                JSONB        NOT NULL,
  flagged_concerns        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  rank_changes            JSONB        NOT NULL DEFAULT '[]'::jsonb,
  reasoning_summary       TEXT         NOT NULL,
  s3_reasoning_full       TEXT,
  llm_model               TEXT         NOT NULL,
  prompt_ver              TEXT         NOT NULL,
  input_tokens            INT          NOT NULL,
  output_tokens           INT          NOT NULL,
  inference_cost_usd      NUMERIC(10,6),
  inference_time_ms       INT,
  input_data_meta         JSONB        NOT NULL DEFAULT '{}'::jsonb
);

v3_6 흐름 (2026-05-19)
═══════════════════════════════════════════════════════════════════
- Phase 4 LLM은 phase3_integrated_ranking.scoring_process JSONB에서
  sub_code 매칭 trace (matched_sub_code/sub_code_authority) 활용 가능
- 본 writer는 LLM 출력만 직렬화 — Phase 3 결과는 별도 (phase3_writer)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional, Protocol


class Phase4WriterDataSource(Protocol):
    """Aurora DB INSERT 클라이언트 추상."""

    def execute_insert(
        self,
        sql: str,
        params: dict[str, Any],
    ) -> None:
        ...


@dataclass
class Phase4WriteRow:
    """phase4_llm_rerank 1 row 데이터."""
    session_id: str                   # Phase 3와 동일 UUID
    executed_at: str                  # ISO 8601 timestamptz
    p3_executed_at: str               # Phase 3 실행 시각
    agrees_with_top1: bool            # Phase 3 top1과 LLM top1 동의 여부 (KPI)
    reranked: list[dict]              # LLM 재정렬된 ranking
    flagged_concerns: list[dict]      # 안전 경고 / 감별 권고
    rank_changes: list[dict]          # Phase 3→4 rank 변동
    reasoning_summary: str            # 한국어 요약 (DB 내)
    s3_reasoning_full: Optional[str]  # S3 URI (전체 추론 본문)
    llm_model: str                    # "claude-sonnet-4-6"
    prompt_ver: str                   # "v4_..."
    input_tokens: int
    output_tokens: int
    inference_cost_usd: Optional[float]
    inference_time_ms: Optional[int]
    input_data_meta: dict


def build_write_row(
    *,
    session_id: str,
    p3_executed_at: str,
    agrees_with_top1: bool,
    reranked: list[dict],
    flagged_concerns: list[dict],
    rank_changes: list[dict],
    reasoning_summary: str,
    llm_model: str,
    prompt_ver: str,
    input_tokens: int,
    output_tokens: int,
    s3_reasoning_full: Optional[str] = None,
    inference_cost_usd: Optional[float] = None,
    inference_time_ms: Optional[int] = None,
    input_data_meta: Optional[dict] = None,
    executed_at: Optional[str] = None,
) -> Phase4WriteRow:
    """Phase 4 verifier 출력 → Phase4WriteRow."""
    if executed_at is None:
        executed_at = datetime.now(timezone.utc).isoformat()

    return Phase4WriteRow(
        session_id=session_id,
        executed_at=executed_at,
        p3_executed_at=p3_executed_at,
        agrees_with_top1=agrees_with_top1,
        reranked=list(reranked),
        flagged_concerns=list(flagged_concerns),
        rank_changes=list(rank_changes),
        reasoning_summary=reasoning_summary,
        s3_reasoning_full=s3_reasoning_full,
        llm_model=llm_model,
        prompt_ver=prompt_ver,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        inference_cost_usd=inference_cost_usd,
        inference_time_ms=inference_time_ms,
        input_data_meta=dict(input_data_meta or {}),
    )


INSERT_SQL_TEMPLATE = """
INSERT INTO soopulai.phase4_llm_rerank (
  session_id, executed_at, p3_executed_at,
  agrees_with_top1, reranked, flagged_concerns, rank_changes,
  reasoning_summary, s3_reasoning_full,
  llm_model, prompt_ver, input_tokens, output_tokens,
  inference_cost_usd, inference_time_ms, input_data_meta
) VALUES (
  %(session_id)s, %(executed_at)s, %(p3_executed_at)s,
  %(agrees_with_top1)s, %(reranked)s::jsonb, %(flagged_concerns)s::jsonb, %(rank_changes)s::jsonb,
  %(reasoning_summary)s, %(s3_reasoning_full)s,
  %(llm_model)s, %(prompt_ver)s, %(input_tokens)s, %(output_tokens)s,
  %(inference_cost_usd)s, %(inference_time_ms)s, %(input_data_meta)s::jsonb
);
"""


def build_insert_params(row: Phase4WriteRow) -> dict[str, Any]:
    """Phase4WriteRow → psycopg2 named-param dict."""
    return {
        "session_id": row.session_id,
        "executed_at": row.executed_at,
        "p3_executed_at": row.p3_executed_at,
        "agrees_with_top1": row.agrees_with_top1,
        "reranked": json.dumps(row.reranked, ensure_ascii=False),
        "flagged_concerns": json.dumps(row.flagged_concerns, ensure_ascii=False),
        "rank_changes": json.dumps(row.rank_changes, ensure_ascii=False),
        "reasoning_summary": row.reasoning_summary,
        "s3_reasoning_full": row.s3_reasoning_full,
        "llm_model": row.llm_model,
        "prompt_ver": row.prompt_ver,
        "input_tokens": row.input_tokens,
        "output_tokens": row.output_tokens,
        "inference_cost_usd": row.inference_cost_usd,
        "inference_time_ms": row.inference_time_ms,
        "input_data_meta": json.dumps(row.input_data_meta, ensure_ascii=False),
    }


def write_row(
    source: Phase4WriterDataSource,
    row: Phase4WriteRow,
) -> dict[str, Any]:
    """Aurora DB에 1 row INSERT."""
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
    "Phase4WriterDataSource",
    "Phase4WriteRow",
    "build_write_row",
    "build_insert_params",
    "write_row",
    "DryRunWriter",
    "INSERT_SQL_TEMPLATE",
]
