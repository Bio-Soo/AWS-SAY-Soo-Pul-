"""환경변수 → Settings dataclass.

문서: §5.6, §6 (운영용 환경변수 일람)

기본은 mock 친화적 값 — 로컬 dev 즉시 부팅 가능. production 은 모든 값 반드시 set.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str | None = None) -> str | None:
    v = os.getenv(name)
    return v if v not in (None, "") else default


@dataclass(frozen=True)
class Settings:
    # ── 진단 폴링 / 시연 ────────────────────────────────────────
    poll_mode: str            # 'fhir' | 'mock'
    poll_interval_sec: float
    # ── FHIR (HAPI 또는 SMART sandbox) ──────────────────────────
    fhir_base_url: str | None
    fhir_auth_token: str | None
    # ── EMR Updates 데모 (배지) ────────────────────────────────
    mock_patient_mrns: tuple[str, ...]
    ws_path: str
    # ── 인증 ───────────────────────────────────────────────────
    jwt_public_key_path: str | None
    jwt_algorithm: str
    jwt_audience: str
    # ── AWS ────────────────────────────────────────────────────
    aws_region: str
    stepfn_state_machine_arn: str | None
    cxr_s3_bucket: str | None
    # ── DB ─────────────────────────────────────────────────────
    database_url: str | None  # async (postgresql+asyncpg://...)
    # ── EMR data source ───────────────────────────────────────
    # 'hapi' (기본, FHIR 서버 proxy) | 's3-mock' (S3 의 정적 JSON · 데모용)
    emr_data_source: str
    s3_mock_bucket: str
    s3_mock_prefix: str

    @classmethod
    def from_env(cls) -> "Settings":
        mode = (_env("POLL_MODE", "fhir") or "fhir").lower()
        if mode not in ("fhir", "mock"):
            raise ValueError(f"POLL_MODE must be 'fhir' or 'mock', got {mode!r}")
        default_interval = 8.0 if mode == "mock" else 30.0
        try:
            interval = float(_env("POLL_INTERVAL", str(default_interval)))
        except ValueError:
            interval = default_interval

        mock_csv = _env("MOCK_PATIENT_MRNS", "20-145982,22-089433") or ""
        mrns = tuple(m.strip() for m in mock_csv.split(",") if m.strip())

        return cls(
            poll_mode=mode,
            poll_interval_sec=max(1.0, interval),
            fhir_base_url=_env("FHIR_BASE_URL"),
            fhir_auth_token=_env("FHIR_AUTH_TOKEN"),
            mock_patient_mrns=mrns,
            ws_path=_env("WS_PATH", "/ws/emr-updates") or "/ws/emr-updates",
            jwt_public_key_path=_env("JWT_PUBLIC_KEY_PATH"),
            jwt_algorithm=_env("JWT_ALGORITHM", "RS256") or "RS256",
            jwt_audience=_env("JWT_AUDIENCE", "rare-link-ai") or "rare-link-ai",
            aws_region=_env("AWS_REGION", "ap-northeast-2") or "ap-northeast-2",
            stepfn_state_machine_arn=_env("STEPFN_STATE_MACHINE_ARN"),
            cxr_s3_bucket=_env("CXR_S3_BUCKET", "say2-2team-bucket"),
            database_url=_env("DATABASE_URL"),
            emr_data_source=(_env("EMR_DATA_SOURCE", "hapi") or "hapi").lower(),
            s3_mock_bucket=_env("S3_MOCK_BUCKET", "say2-2team-bucket") or "say2-2team-bucket",
            s3_mock_prefix=_env("S3_MOCK_PREFIX", "mock-emr") or "mock-emr",
        )
