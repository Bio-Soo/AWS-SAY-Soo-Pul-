"""Phase 2 — X-ray → DenseNet 14-class HPO 변환 + DB INSERT.

기존 phase2-vision (2026-05-08, 4101 bytes) 는 S3 result 저장만 했음.
이 버전은 phase1-symptom-dev 패턴 따라:
  1. session_id 받음 (Step Functions input)
  2. xray_s3_key 가 명시되지 않으면 imaging_study 테이블에서 가장 최근 row read
  3. SageMaker invoke (say2-2team-soonet-endpoint)
  4. phase_execution_log INSERT (started → succeeded/failed)
  5. phase2_xray_processing INSERT (production v1.1 schema)
  6. S3 에 result JSON 저장 (기존 패턴 유지)

Input 형식 (Step Functions 또는 직접 invoke):
    {
      "session_id":  "<uuid>",        # 필수
      "patient_id":  "20-145982",     # optional (DB 조회용)
      "xray_s3_key": "cheXpert_data/...",   # optional. 없으면 imaging_study 에서 read
      "cxr_s3_key":  "...",            # 별칭. xray_s3_key 와 동일 처리
      "threshold":   0.3               # optional
    }

Output (API GW proxy 형식):
    statusCode=200, body=JSON({session_id, study_id, predictions, positive_hpos, ...})
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
import uuid
from typing import Any

import boto3

try:
    import psycopg2
    from psycopg2.extras import Json as PgJson
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False

sys.path.insert(0, "/var/task")
sys.path.insert(1, "/opt/python")

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# ── 환경변수 ─────────────────────────────────────────────────────
ENDPOINT  = os.environ.get("SAGEMAKER_ENDPOINT", "say2-2team-soonet-endpoint")
BUCKET    = os.environ.get("S3_BUCKET", "say2-2team-bucket")
S3_PREFIX = os.environ.get("S3_PREFIX", "Phase_2")
THRESHOLD = float(os.environ.get("XRAY_THRESHOLD", "0.3"))

# ── AWS clients (cold start 1회) ─────────────────────────────────
s3       = boto3.client("s3")
runtime  = boto3.client("sagemaker-runtime")

# ── DB 연동 (phase1/3/4/5 와 동일 패턴) ──────────────────────────
DB_HOST   = "patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com"
DB_NAME   = "soopul"
DB_USER   = "app_user"
DB_SECRET = "soopul/aurora/app-user"
DB_REGION = "ap-northeast-2"


def _get_db_conn():
    if not DB_AVAILABLE:
        return None
    try:
        sm = boto3.client("secretsmanager", region_name=DB_REGION)
        secret_str = sm.get_secret_value(SecretId=DB_SECRET)["SecretString"]
        try:
            pwd = json.loads(secret_str)["password"]
        except (json.JSONDecodeError, KeyError, TypeError):
            pwd = secret_str
        return psycopg2.connect(
            host=DB_HOST, port=5432, database=DB_NAME, user=DB_USER, password=pwd,
            options="-c search_path=soopulai", connect_timeout=10,
        )
    except Exception as e:
        logger.warning("DB 연결 실패: %s", e)
        return None


# ── 14-class HPO 매핑 (soo_net.py 와 동일) ──────────────────────
HPO_MAP = {
    "Atelectasis":                  "HP:0002095",
    "Cardiomegaly":                 "HP:0001640",
    "Consolidation":                "HP:0002113",
    "Edema":                        "HP:0002111",
    "Enlarged Cardiomediastinum":   "HP:0034251",
    "Fracture":                     "HP:0002757",
    "Lung Lesion":                  "HP:0025000",
    "Lung Opacity":                 "HP:0002088",
    "No Finding":                   "Normal (N/A)",
    "Pleural Effusion":             "HP:0002202",
    "Pleural Other":                "HP:0002102",
    "Pneumonia":                    "HP:0002090",
    "Pneumothorax":                 "HP:0002107",
    "Support Devices":              "Device (N/A)",
}


def _classify_error(exc: Exception) -> str:
    name = type(exc).__name__
    if name in ("ValueError", "TypeError", "KeyError"):
        return "validation"
    if "timeout" in str(exc).lower():
        return "infra"
    if "boto" in name.lower() or "ClientError" in name:
        return "external_api"
    return "infra"


def _record_phase_log(
    session_id=None, patient_id=None,
    phase_step="", status="started",
    started_at=None, input_summary=None, output_summary=None, error=None,
    lambda_request_id="", lambda_function="", model_versions=None,
):
    conn = _get_db_conn()
    if not conn:
        return None
    log_id = str(uuid.uuid4())
    try:
        cur = conn.cursor()
        err_code = err_msg = err_trace = err_cat = None
        if error is not None:
            err_code = type(error).__name__.upper()[:64]
            err_msg = str(error)[:8000]
            err_trace = "".join(traceback.format_exception(type(error), error, error.__traceback__))[:16000]
            err_cat = _classify_error(error)
        duration_ms = int((time.time() - started_at) * 1000) if started_at else None
        cur.execute(
            """
            INSERT INTO phase_execution_log (
                log_id, session_id, patient_id,
                phase_name, phase_step, status,
                started_at, completed_at, duration_ms,
                lambda_function, lambda_request_id,
                input_summary, output_summary,
                error_code, error_message, error_stacktrace, error_category,
                model_versions
            ) VALUES (
                %s, %s, %s, %s, %s, %s,
                COALESCE(to_timestamp(%s), NOW()), NOW(), %s,
                %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (log_id, session_id, patient_id, "phase2", phase_step, status,
             started_at, duration_ms, lambda_function, lambda_request_id,
             PgJson(input_summary) if input_summary else None,
             PgJson(output_summary) if output_summary else None,
             err_code, err_msg, err_trace, err_cat,
             PgJson(model_versions) if model_versions else None),
        )
        conn.commit()
        return log_id
    except Exception as e:
        logger.warning("phase_execution_log INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


def _mark_session_failed(session_id, error_msg):
    if not session_id:
        return
    conn = _get_db_conn()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE diagnosis_session SET status='failed', error_message=%s, completed_at=NOW(), current_phase=2 WHERE session_id=%s",
            (str(error_msg)[:1000], session_id),
        )
        conn.commit()
    except Exception as e:
        logger.warning("diagnosis_session UPDATE 실패: %s", e)
    finally:
        conn.close()


def _read_latest_imaging_study(patient_id: str | None, session_id: str | None):
    """session_id 또는 patient_id 로 가장 최근 imaging_study 한 row 가져오기."""
    if not (patient_id or session_id):
        return None
    conn = _get_db_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        if patient_id:
            cur.execute(
                """SELECT study_id, s3_uri_png, modality, view_position
                   FROM imaging_study WHERE patient_id=%s
                   ORDER BY ingested_at DESC LIMIT 1""",
                (patient_id,),
            )
        else:
            cur.execute(
                """SELECT i.study_id, i.s3_uri_png, i.modality, i.view_position
                   FROM imaging_study i
                   JOIN diagnosis_session ds ON ds.patient_id=i.patient_id
                   WHERE ds.session_id=%s
                   ORDER BY i.ingested_at DESC LIMIT 1""",
                (session_id,),
            )
        row = cur.fetchone()
        if not row:
            return None
        return {
            "study_id": str(row[0]),
            "s3_uri_png": row[1],
            "modality": row[2],
            "view_position": row[3],
        }
    except Exception as e:
        logger.warning("imaging_study SELECT 실패: %s", e)
        return None
    finally:
        conn.close()


def _insert_phase2_result(
    session_id, study_id, xray_s3_key, predictions,
    densenet_model_ver, inference_time_ms, xray_hpo_inferred,
):
    """phase2_xray_processing INSERT — production schema NOT NULL 충족."""
    if not session_id:
        return None
    conn = _get_db_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        # NOT NULL: session_id, phase, executed_at, study_id, s3_original_full,
        #          s3_original_512, s3_lung_mask_512, s3_heart_mask_512,
        #          unet_model_ver, densenet_findings, densenet_model_ver.
        # FK: study_id → imaging_study(study_id). 매번 imaging_study 에서 read.
        # study_id 없으면 INSERT skip (FK 위반 회피).
        if not study_id:
            logger.info("phase2: study_id 없음 → DB INSERT skip (imaging_study row 없음)")
            return None
        sid = study_id
        cur.execute(
            """
            INSERT INTO phase2_xray_processing (
                session_id, phase, executed_at, study_id,
                s3_original_full, s3_original_512,
                s3_lung_mask_512, s3_heart_mask_512,
                unet_model_ver,
                densenet_findings, densenet_model_ver,
                xray_hpo_inferred, inference_time_ms,
                mask_quality_flag
            ) VALUES (
                %s, 2, NOW(), %s,
                %s, %s,
                %s, %s,
                %s,
                %s, %s,
                %s, %s, %s
            )
            """,
            (
                session_id, sid,
                xray_s3_key, xray_s3_key,                    # 원본 = 512 (resize 안 함, placeholder)
                "(unet_skipped)", "(unet_skipped)",          # mask 안 만듦 — NOT NULL 채움
                "not_used",                                  # unet_model_ver NOT NULL
                PgJson(predictions), densenet_model_ver,
                PgJson(xray_hpo_inferred), inference_time_ms,
                None,                                        # mask_quality_flag (CHK: null OK)
            ),
        )
        conn.commit()
        return True
    except Exception as e:
        logger.warning("phase2_xray_processing INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


# ── 응답 helpers ────────────────────────────────────────────────
def _ok(payload: Any) -> dict:
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(payload, default=str, ensure_ascii=False),
    }


def _bad(msg: str, status: int = 400) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps({"error": msg}, ensure_ascii=False),
    }


def _server_error(exc: Exception) -> dict:
    logger.exception("phase2 unhandled error: %s", exc)
    return {
        "statusCode": 500,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps({"error": "internal_server_error", "type": type(exc).__name__},
                           ensure_ascii=False),
    }


# ── Lambda 진입점 ────────────────────────────────────────────────
def lambda_handler(event: dict, context) -> dict:
    request_id = getattr(context, "aws_request_id", "local")
    function_name = getattr(context, "function_name", "phase2-vision")
    t_started = time.time()

    # /health
    if (event.get("path") or event.get("rawPath", "")).endswith("/health"):
        return _ok({"status": "ok", "endpoint": ENDPOINT})

    # API GW proxy → body string, 직접 invoke → dict
    body = event.get("body") if isinstance(event.get("body"), (str, dict)) else event
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            return _bad("body is not valid JSON")
    if not isinstance(body, dict):
        return _bad("expected JSON object")

    session_id = event.get("session_id") or body.get("session_id")
    patient_id = event.get("patient_id") or body.get("patient_id")
    xray_s3_key = (body.get("xray_s3_key") or body.get("cxr_s3_key")
                   or event.get("xray_s3_key") or event.get("cxr_s3_key"))
    threshold = float(body.get("threshold", THRESHOLD))

    # 1) imaging_study row 무조건 read (study_id FK 필요)
    #    xray_s3_key 가 명시되지 않았으면 그 row 의 s3_uri_png 사용.
    study_meta = _read_latest_imaging_study(patient_id, session_id)
    if not xray_s3_key and study_meta:
        xray_s3_key = study_meta["s3_uri_png"]

    # leading slash / s3:// prefix 정리
    if xray_s3_key:
        if xray_s3_key.startswith("s3://"):
            _, _, _, *rest = xray_s3_key.split("/", 3)
            xray_s3_key = rest[0] if rest else xray_s3_key
        xray_s3_key = xray_s3_key.lstrip("/")

    if not xray_s3_key:
        msg = "xray_s3_key required (or session_id/patient_id with imaging_study row)"
        _record_phase_log(session_id=session_id, patient_id=patient_id,
                          phase_step="resolve_image", status="failed",
                          started_at=t_started, error=ValueError(msg),
                          lambda_function=function_name, lambda_request_id=request_id)
        return _bad(msg)

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_step="sagemaker_invoke", status="started",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        input_summary={"xray_s3_key": xray_s3_key, "threshold": threshold},
        model_versions={"endpoint": ENDPOINT},
    )

    # 2) S3 에서 이미지 로드
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=xray_s3_key)
        image_bytes = obj["Body"].read()
    except Exception as e:
        _record_phase_log(session_id=session_id, patient_id=patient_id,
                          phase_step="s3_read", status="failed",
                          started_at=t_started, error=e,
                          lambda_function=function_name, lambda_request_id=request_id)
        _mark_session_failed(session_id, f"s3 read: {e}")
        return _server_error(e)

    # 3) SageMaker invoke
    t0 = time.perf_counter()
    try:
        resp = runtime.invoke_endpoint(
            EndpointName=ENDPOINT,
            ContentType="application/x-image",
            Body=image_bytes,
        )
        predictions = json.loads(resp["Body"].read())
    except Exception as e:
        _record_phase_log(session_id=session_id, patient_id=patient_id,
                          phase_step="sagemaker_invoke", status="failed",
                          started_at=t_started, error=e,
                          lambda_function=function_name, lambda_request_id=request_id)
        _mark_session_failed(session_id, f"sagemaker: {e}")
        return _server_error(e)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    # 4) HPO 추출 (임계값 이상 + N/A 제외)
    positive_hpos = []
    xray_detail = {}
    for label, info in predictions.items():
        prob = float(info.get("probability", 0.0))
        hpo = info.get("hpo_code") or HPO_MAP.get(label, "N/A")
        xray_detail[label] = [prob, hpo]
        if prob >= threshold and "N/A" not in hpo:
            positive_hpos.append(hpo)

    # 5) S3 에 result JSON 저장 (기존 패턴 유지)
    result_key = f"{S3_PREFIX}/results/phase2/{uuid.uuid4().hex}.json"
    result_payload = {
        "session_id": session_id,
        "xray_s3_key": xray_s3_key,
        "threshold": threshold,
        "predictions": predictions,
        "positive_hpos": positive_hpos,
        "xray_detail": xray_detail,
    }
    try:
        s3.put_object(
            Bucket=BUCKET, Key=result_key,
            Body=json.dumps(result_payload, ensure_ascii=False).encode("utf-8"),
            ContentType="application/json",
        )
    except Exception as e:
        logger.warning("S3 result save 실패 (계속): %s", e)
        result_key = None

    # 6) phase2_xray_processing INSERT (production DB)
    densenet_model_ver = "soonet-v5"
    _insert_phase2_result(
        session_id=session_id,
        study_id=study_meta["study_id"] if study_meta else None,
        xray_s3_key=xray_s3_key,
        predictions=predictions,
        densenet_model_ver=densenet_model_ver,
        inference_time_ms=elapsed_ms,
        xray_hpo_inferred={"positive_hpos": positive_hpos, "xray_detail": xray_detail},
    )

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_step="sagemaker_invoke", status="succeeded",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        output_summary={"positive_count": len(positive_hpos), "elapsed_ms": elapsed_ms},
        model_versions={"endpoint": ENDPOINT, "densenet_model_ver": densenet_model_ver},
    )

    return _ok({
        "session_id": session_id,
        "study_id": study_meta["study_id"] if study_meta else None,
        "xray_s3_key": xray_s3_key,
        "result_s3_key": result_key,
        "predictions": predictions,
        "positive_hpos": positive_hpos,
        "xray_detail": xray_detail,
        "metadata": {
            "endpoint": ENDPOINT,
            "densenet_model_ver": densenet_model_ver,
            "elapsed_ms": elapsed_ms,
            "request_id": request_id,
        },
    })
