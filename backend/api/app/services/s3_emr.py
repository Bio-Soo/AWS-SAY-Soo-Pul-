"""S3-backed mock EMR data source.

EMR_DATA_SOURCE=s3-mock 일 때 사용. boto3 로 S3 에서 worklist.json + patients/{mrn}.json
을 읽어 PatientWorklistItem / PatientDetail 모양으로 반환.

S3 layout:
  s3://<bucket>/<prefix>/worklist.json           · WorklistResponse 모양
  s3://<bucket>/<prefix>/patients/{mrn}.json     · PatientDetail 모양

환경변수:
  S3_MOCK_BUCKET   · 기본 say2-2team-bucket
  S3_MOCK_PREFIX   · 기본 mock-emr
"""

from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def _bucket() -> str:
    return os.getenv("S3_MOCK_BUCKET", "say2-2team-bucket")


def _prefix() -> str:
    return os.getenv("S3_MOCK_PREFIX", "mock-emr").strip("/")


@lru_cache(maxsize=1)
def _s3():
    return boto3.client("s3")


def get_worklist() -> dict[str, Any]:
    """s3://<bucket>/<prefix>/worklist.json 을 fetch."""
    key = f"{_prefix()}/worklist.json"
    try:
        obj = _s3().get_object(Bucket=_bucket(), Key=key)
        body = obj["Body"].read()
        return json.loads(body.decode("utf-8"))
    except ClientError as e:
        logger.exception("S3 worklist read failed bucket=%s key=%s", _bucket(), key)
        raise


def get_patient(mrn: str) -> dict[str, Any] | None:
    """s3://<bucket>/<prefix>/patients/{mrn}.json. 없으면 None."""
    key = f"{_prefix()}/patients/{mrn}.json"
    try:
        obj = _s3().get_object(Bucket=_bucket(), Key=key)
        body = obj["Body"].read()
        return json.loads(body.decode("utf-8"))
    except _s3().exceptions.NoSuchKey:
        return None
    except ClientError as e:
        # 404 도 ClientError 로 들어올 수 있음
        if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        logger.exception("S3 patient read failed bucket=%s key=%s", _bucket(), key)
        raise
