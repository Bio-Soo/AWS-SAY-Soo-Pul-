"""중앙 설정 — 환경변수 LUNG_DX_ 접두어로 오버라이드 가능."""

from __future__ import annotations

from pydantic_settings import BaseSettings
from pydantic import Field
from pathlib import Path

from . import paths


class Settings(BaseSettings):
    """local / aws 모드를 설정값 하나로 전환할 수 있는 중앙 설정."""

    # ── 환경 ─────────────────────────────────────────────────
    environment: str = Field("local", description="local | aws")

    # ── Phase 2: X-ray 모델 백엔드 ──────────────────────────
    xray_backend: str = Field("local", description="local | sagemaker")
    chexnet_weights_path: str = Field(
        str(paths.MODEL_DIR / "chexnet_weights.pth"),
        description="로컬 CheXNet 가중치 경로",
    )
    sagemaker_endpoint: str = Field("", description="SageMaker endpoint 이름")
    xray_detection_threshold: float = Field(0.5, description="확정 소견 임계값")
    xray_possible_threshold: float = Field(0.3, description="의심 소견 임계값")

    # ── Phase 2: 진단 스코어링 ───────────────────────────────
    default_weight_symptoms: float = 0.25
    default_weight_lab: float = 0.20
    default_weight_radiology: float = 0.35
    default_weight_micro: float = 0.20
    top_n_diseases: int = Field(10, description="상위 N개 질환 출력")

    # ── Phase 5: 희귀질환 스크리닝 ───────────────────────────
    rare_trigger_threshold: float = Field(
        0.5, description="Phase 2 최고점수가 이 값 미만이면 희귀질환 스크리닝 트리거"
    )
    always_screen_rare: bool = Field(False, description="항상 희귀질환 스크리닝 수행")
    rare_top_n: int = Field(20, description="상위 N개 희귀질환 출력")

    # ── Phase 4: 리포트 생성 백엔드 ──────────────────────────
    report_backend: str = Field("template", description="template | bedrock")
    bedrock_model_id: str = Field(
        "anthropic.claude-sonnet-4-20250514",
        description="Bedrock 모델 ID",
    )
    bedrock_region: str = Field("us-east-1", description="Bedrock 리전")

    # ── 데이터 백엔드 ────────────────────────────────────────
    data_backend: str = Field("local", description="local | s3")
    s3_bucket: str = Field("", description="S3 버킷 이름")

    # ── MIMIC ETL ────────────────────────────────────────────
    chunk_size: int = Field(500_000, description="CSV 청크 크기")

    model_config = {"env_prefix": "LUNG_DX_"}


def get_settings() -> Settings:
    """싱글톤 패턴으로 Settings 반환."""
    return Settings()
