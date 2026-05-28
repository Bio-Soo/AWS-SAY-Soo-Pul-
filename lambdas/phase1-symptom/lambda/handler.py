"""Phase 1 — Symptom → HPO 추출 Lambda handler.

Input (Step Functions 또는 API Gateway proxy):
    {"session_id": "uuid", "patient_id": "...", "symptom_text": "..."}

처리:
    1. (cold start 1회) S3 에서 hpo_official.json 다운로드 → /tmp 캐시
    2. BedrockHPOExtractor 로 임상 노트 → positive/negative HPO ID 추출
    3. Aurora 의 phase1_result INSERT (positive_hpo, negative_hpo, raw_response)
    4. phase_execution_log INSERT (Phase 3, 4, 5 통합 로깅 패턴)

Output (API GW proxy):
    {"statusCode": 200,
     "body": "{\"positive_hpo\":[...], \"negative_hpo\":[...], \"unmapped\":[...], \"hp_id_to_term\":{...}}"}

Environment:
    BEDROCK_MODEL_ID    (default anthropic.claude-3-5-sonnet-20240620-v1:0)
    BEDROCK_REGION      (default ap-northeast-2)
    S3_BUCKET           (default say2-2team-bucket)
    HPO_JSON_KEY        (default Phase_1/hpo_official.json)
    HPO_JSON_LOCAL      (default /tmp/hpo_official.json)
"""
from __future__ import annotations

import difflib
import json
import logging
import os
import sys
import time
import traceback
import uuid
from typing import Any, Dict, List, Optional, Tuple

import boto3

try:
    import psycopg2
    from psycopg2.extras import Json as PgJson
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False

# Lambda Layer / handler 경로
sys.path.insert(0, "/var/task")
sys.path.insert(1, "/opt/python")

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# ────────────────────────────────────────────────────────────────
# DB 연동 (phase3/phase4/phase5-lr 동일 패턴)
# ────────────────────────────────────────────────────────────────
DB_HOST = "patient-db-cluster.cluster-cxmiyawwwhbt.ap-northeast-2.rds.amazonaws.com"
DB_NAME = "soopul"
DB_USER = "app_user"
DB_SECRET_ID = "soopul/aurora/app-user"
DB_REGION = "ap-northeast-2"


def _get_db_conn():
    if not DB_AVAILABLE:
        return None
    try:
        sm = boto3.client("secretsmanager", region_name=DB_REGION)
        secret_str = sm.get_secret_value(SecretId=DB_SECRET_ID)["SecretString"]
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


def _classify_error(exc: Exception) -> str:
    name = type(exc).__name__
    if name in ("ValueError", "TypeError", "KeyError"):
        return "validation"
    if name in ("TimeoutError",) or "timeout" in str(exc).lower():
        return "infra"
    if "boto" in name.lower() or "ClientError" in name or "EndpointConnection" in name:
        return "external_api"
    return "infra"


def _record_phase_log(
    session_id=None, patient_id=None,
    phase_name="phase1", phase_step="", status="started",
    started_at=None, input_summary=None, output_summary=None, error=None,
    lambda_request_id="", lambda_function="", model_versions=None,
):
    conn = _get_db_conn()
    if not conn:
        return None
    log_id = str(uuid.uuid4())
    try:
        cur = conn.cursor()
        error_code = error_message = error_stacktrace = error_category = None
        if error is not None:
            error_code = type(error).__name__.upper()[:64]
            error_message = str(error)[:8000]
            error_stacktrace = "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )[:16000]
            error_category = _classify_error(error)
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
                %s, %s, %s,
                %s, %s, %s,
                COALESCE(to_timestamp(%s), NOW()), NOW(), %s,
                %s, %s,
                %s, %s,
                %s, %s, %s, %s,
                %s
            )
            """,
            (
                log_id, session_id, patient_id,
                phase_name, phase_step, status,
                started_at, duration_ms,
                lambda_function, lambda_request_id,
                PgJson(input_summary) if input_summary else None,
                PgJson(output_summary) if output_summary else None,
                error_code, error_message, error_stacktrace, error_category,
                PgJson(model_versions) if model_versions else None,
            ),
        )
        conn.commit()
        return log_id
    except Exception as e:
        logger.warning("phase_execution_log INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


def _mark_session_failed(session_id, error_msg, phase=1):
    if not session_id:
        return
    conn = _get_db_conn()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE diagnosis_session
            SET status='failed', error_message=%s, completed_at=NOW(), current_phase=%s
            WHERE session_id=%s
            """,
            (str(error_msg)[:1000], phase, session_id),
        )
        conn.commit()
    except Exception as e:
        logger.warning("diagnosis_session UPDATE 실패: %s", e)
    finally:
        conn.close()


def _insert_phase1_result(session_id, positive_hpo_detail, negative_hpo_detail,
                          unmapped, model_id, inference_time_ms):
    """phase1_hpo_extraction INSERT (production schema · v1.1).

    Composite PK (session_id, phase, executed_at) — phase=1 default.

    Schema 정렬 (2026-05-19):
      positive_hpo / negative_hpo  →  list[str] (HPO ID only) — schemas.Phase1Result 와 정합
      detail (exact_quote, official_term, llm_extracted_term)  →  extraction_stats 에 보존
      unmapped 는 그대로 unmapped_terms 에.

    Downstream Lambda 호환:
      phase5-lr db_reader / phase5-rag rag_llm_3 / phase3 SymptomMatcher 모두
      list[str] 가정 코드라 이 형식이 자연 정합.
    """
    if not session_id:
        return None
    positive_ids = [x["hpo_id"] for x in positive_hpo_detail if x.get("hpo_id")]
    negative_ids = [x["hpo_id"] for x in negative_hpo_detail if x.get("hpo_id")]
    conn = _get_db_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO phase1_hpo_extraction (
                session_id, phase, executed_at,
                input_note_ids, positive_hpo, negative_hpo,
                llm_model, inference_time_ms, unmapped_terms, extraction_stats
            ) VALUES (
                %s, 1, NOW(),
                %s, %s, %s,
                %s, %s, %s, %s
            )
            """,
            (
                session_id,
                [],                                                # input_note_ids — 직접 invoke 일 땐 빈 배열
                PgJson(positive_ids),                              # list[str]
                PgJson(negative_ids),                              # list[str]
                model_id,
                inference_time_ms,
                PgJson(unmapped),
                PgJson({
                    "positive_count": len(positive_ids),
                    "negative_count": len(negative_ids),
                    "unmapped_count": len(unmapped),
                    "positive_detail": positive_hpo_detail,        # raw LLM detail 보존
                    "negative_detail": negative_hpo_detail,
                }),
            ),
        )
        conn.commit()
        return True
    except Exception as e:
        logger.warning("phase1_hpo_extraction INSERT 실패: %s", e)
        return None
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────
# BedrockHPOExtractor (s3_clone/Phase_1/symptom_llm_4.py 의 압축본)
# Lambda 환경에 맞춰 파일 출력 / 로깅 제거, 핵심 로직만 유지.
# ────────────────────────────────────────────────────────────────
class BedrockHPOExtractor:
    def __init__(self, region_name: str, hpo_json_path: str, model_id: str):
        self.bedrock_client = boto3.client("bedrock-runtime", region_name=region_name)
        self.model_id = model_id
        self.hpo_id_to_term: Dict[str, str] = {}
        self.term_to_hpo_id: Dict[str, str] = {}

        with open(hpo_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for node in data.get("graphs", [{}])[0].get("nodes", []):
            node_id_raw = node.get("id", "")
            if not node_id_raw.startswith("http://purl.obolibrary.org/obo/HP_"):
                continue
            hpo_id = node_id_raw.split("/")[-1].replace("_", ":")
            primary_label = node.get("lbl", "")
            if not primary_label:
                continue
            self.hpo_id_to_term[hpo_id] = primary_label
            self.term_to_hpo_id[primary_label.lower().strip()] = hpo_id
            for syn in node.get("meta", {}).get("synonyms", []):
                syn_val = syn.get("val")
                if syn_val:
                    self.term_to_hpo_id[syn_val.lower().strip()] = hpo_id
        logger.info("HPO loaded: %d primary, %d total labels/synonyms",
                    len(self.hpo_id_to_term), len(self.term_to_hpo_id))

    def _reference_candidates(self, keywords: List[str]) -> str:
        candidates = set()
        all_terms = list(self.term_to_hpo_id.keys())
        for kw in keywords:
            kw_clean = kw.lower().strip()
            if len(kw_clean) < 3:
                continue
            match_count = 0
            for term in all_terms:
                if kw_clean in term:
                    hid = self.term_to_hpo_id[term]
                    candidates.add(f"{self.hpo_id_to_term.get(hid, term)} ({hid})")
                    match_count += 1
                if match_count > 15:
                    break
            for m in difflib.get_close_matches(kw_clean, all_terms, n=5, cutoff=0.7):
                hid = self.term_to_hpo_id[m]
                candidates.add(f"{self.hpo_id_to_term.get(hid, m)} ({hid})")
            if len(candidates) > 150:
                break
        return "\n".join(candidates)

    def _map_to_hpo(self, term: str) -> Tuple[Optional[str], Optional[str]]:
        term_lower = term.lower().strip()
        if term_lower in self.term_to_hpo_id:
            hid = self.term_to_hpo_id[term_lower]
            return hid, self.hpo_id_to_term.get(hid, term)
        for db_term, hid in self.term_to_hpo_id.items():
            if term_lower in db_term or db_term in term_lower:
                return hid, self.hpo_id_to_term.get(hid, db_term)
        matches = difflib.get_close_matches(term_lower, self.term_to_hpo_id.keys(),
                                            n=1, cutoff=0.8)
        if matches:
            hid = self.term_to_hpo_id[matches[0]]
            return hid, self.hpo_id_to_term.get(hid, matches[0])
        return None, None

    def extract(self, clinical_note: str) -> Dict[str, Any]:
        # Step 1 — Discovery
        try:
            disc_body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 200,
                "messages": [{"role": "user",
                              "content": f"Identify 5-10 core medical/phenotypic keywords in English for this clinical note: \"{clinical_note}\". Return ONLY a comma-separated list."}],
                "temperature": 0.0,
            })
            disc = self.bedrock_client.invoke_model(body=disc_body, modelId=self.model_id)
            keywords_raw = json.loads(disc["body"].read().decode())["content"][0]["text"]
            keywords = [k.strip() for k in keywords_raw.split(",")]
            hpo_ref = self._reference_candidates(keywords)
        except Exception as e:
            logger.warning("discovery step failed: %s", e)
            hpo_ref = "Search official HPO terminology."

        # Step 2 — Final extraction
        system_prompt = f"""
You are an expert clinical informatician.
Your task is to analyze clinical notes written in Korean and extract clinical findings.

### REFERENCE HPO TERMS (Use these EXACT labels if they match the context):
{hpo_ref}

### Instructions:
1. MANDATORY ALIGNMENT: Prioritize using EXACT labels from REFERENCE HPO TERMS.
2. ATOMIC EXTRACTION: Extract EXACTLY ONE symptom per JSON object.
3. NO NEGATION: `english_term` is the core symptom without negation words.
4. ACCURACY: Capture every clinical finding individually.
5. FORMAT: Return ONLY raw JSON.

JSON Output Schema:
{{
    "positive_findings": [{{ "exact_quote_from_text": "...", "english_term": "..." }}],
    "negative_findings": [{{ "exact_quote_from_text": "...", "english_term": "..." }}]
}}
"""
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "system": system_prompt,
            "messages": [{"role": "user",
                          "content": f"Extract symptoms in HPO format from this note: \"{clinical_note}\""}],
            "temperature": 0.0,
        })
        resp = self.bedrock_client.invoke_model(
            body=body, modelId=self.model_id,
            accept="application/json", contentType="application/json",
        )
        raw_text = json.loads(resp["body"].read().decode("utf-8"))["content"][0]["text"].strip()
        s, e = raw_text.find("{"), raw_text.rfind("}")
        if s == -1 or e == -1:
            raise ValueError("Bedrock response contains no JSON object")
        raw_findings = json.loads(raw_text[s:e + 1])

        # Step 3 — Map to HPO IDs
        result = {"positive_hpos": [], "negative_hpos": [], "unmapped_findings": []}
        for kind, dst in [("positive_findings", "positive_hpos"),
                          ("negative_findings", "negative_hpos")]:
            for item in raw_findings.get(kind, []):
                term = item.get("english_term", "")
                hid, official = self._map_to_hpo(term)
                if hid:
                    result[dst].append({
                        "exact_quote_from_text": item.get("exact_quote_from_text", ""),
                        "hpo_id": hid,
                        "official_term": official,
                        "llm_extracted_term": term,
                    })
                else:
                    result["unmapped_findings"].append(item)
        return result


# ────────────────────────────────────────────────────────────────
# Cold-start globals
# ────────────────────────────────────────────────────────────────
_EXTRACTOR: Optional[BedrockHPOExtractor] = None
_HPO_LOADED_AT: Optional[str] = None


def _ensure_initialized():
    """Cold start 1회. S3 hpo_official.json → /tmp 캐시 → extractor init."""
    global _EXTRACTOR, _HPO_LOADED_AT
    if _EXTRACTOR is not None:
        return

    bucket = os.environ.get("S3_BUCKET", "say2-2team-bucket")
    key = os.environ.get("HPO_JSON_KEY", "Phase_1/hpo_official.json")
    local = os.environ.get("HPO_JSON_LOCAL", "/tmp/hpo_official.json")

    if not os.path.exists(local):
        t0 = time.perf_counter()
        s3 = boto3.client("s3", region_name=os.environ.get("BEDROCK_REGION", "ap-northeast-2"))
        s3.download_file(bucket, key, local)
        logger.info("hpo_official.json downloaded in %.2fs (s3://%s/%s)",
                    time.perf_counter() - t0, bucket, key)

    _EXTRACTOR = BedrockHPOExtractor(
        region_name=os.environ.get("BEDROCK_REGION", "ap-northeast-2"),
        hpo_json_path=local,
        model_id=os.environ.get("BEDROCK_MODEL_ID",
                                "anthropic.claude-3-5-sonnet-20240620-v1:0"),
    )
    _HPO_LOADED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ────────────────────────────────────────────────────────────────
# 응답 helpers
# ────────────────────────────────────────────────────────────────
def _ok(payload: Any) -> dict:
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(payload, default=str, ensure_ascii=False),
    }


def _bad(msg: str, status: int = 400) -> dict:
    logger.warning("phase1 client error: %s", msg)
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps({"error": msg}, ensure_ascii=False),
    }


def _server_error(exc: Exception) -> dict:
    logger.exception("phase1 unhandled error: %s", exc)
    return {
        "statusCode": 500,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(
            {"error": "internal_server_error", "type": type(exc).__name__},
            ensure_ascii=False,
        ),
    }


# ────────────────────────────────────────────────────────────────
# Lambda 진입점
# ────────────────────────────────────────────────────────────────
def lambda_handler(event: dict, context) -> dict:
    request_id = getattr(context, "aws_request_id", "local")
    function_name = getattr(context, "function_name", "phase1")
    t_started = time.time()

    path = event.get("path") or event.get("rawPath") or ""
    if path.endswith("/health"):
        return _ok({"status": "ok", "hpo_loaded": _EXTRACTOR is not None,
                    "hpo_loaded_at": _HPO_LOADED_AT})

    session_id = event.get("session_id")
    patient_id = event.get("patient_id")

    try:
        _ensure_initialized()
    except Exception as e:
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase1", phase_step="ensure_initialized", status="failed",
            started_at=t_started, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"init: {e}", phase=1)
        return _server_error(e)

    # API GW proxy 면 body 가 string, 직접 invoke 면 dict
    body = event.get("body") if isinstance(event.get("body"), (str, dict)) else event
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            return _bad("body is not valid JSON")
    if not isinstance(body, dict):
        return _bad("expected JSON object")

    session_id = session_id or body.get("session_id")
    patient_id = patient_id or body.get("patient_id")
    symptom_text = body.get("symptom_text") or body.get("clinical_note")
    if not symptom_text or not isinstance(symptom_text, str):
        return _bad("symptom_text is required and must be a string")

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase1", phase_step="extract", status="started",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        input_summary={"symptom_text_len": len(symptom_text)},
        model_versions={"model_id": os.environ.get("BEDROCK_MODEL_ID")},
    )

    t0 = time.perf_counter()
    try:
        result = _EXTRACTOR.extract(symptom_text)
    except Exception as e:
        _record_phase_log(
            session_id=session_id, patient_id=patient_id,
            phase_name="phase1", phase_step="extract", status="failed",
            started_at=t_started, error=e,
            lambda_function=function_name, lambda_request_id=request_id,
        )
        _mark_session_failed(session_id, f"extract: {e}", phase=1)
        return _server_error(e)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    positive_ids = [x["hpo_id"] for x in result["positive_hpos"]]
    negative_ids = [x["hpo_id"] for x in result["negative_hpos"]]

    _insert_phase1_result(
        session_id=session_id,
        positive_hpo_detail=result["positive_hpos"],
        negative_hpo_detail=result["negative_hpos"],
        unmapped=result["unmapped_findings"],
        model_id=os.environ.get("BEDROCK_MODEL_ID"),
        inference_time_ms=int(elapsed_ms),
    )

    _record_phase_log(
        session_id=session_id, patient_id=patient_id,
        phase_name="phase1", phase_step="extract", status="succeeded",
        started_at=t_started,
        lambda_function=function_name, lambda_request_id=request_id,
        output_summary={
            "positive_count": len(positive_ids),
            "negative_count": len(negative_ids),
            "unmapped_count": len(result["unmapped_findings"]),
            "elapsed_ms": round(elapsed_ms, 2),
        },
        model_versions={"model_id": os.environ.get("BEDROCK_MODEL_ID")},
    )

    return _ok({
        "session_id": session_id,
        "positive_hpo": positive_ids,
        "negative_hpo": negative_ids,
        "unmapped": result["unmapped_findings"],
        "positive_detail": result["positive_hpos"],
        "negative_detail": result["negative_hpos"],
        "metadata": {
            "model_id": os.environ.get("BEDROCK_MODEL_ID"),
            "request_id": request_id,
            "elapsed_ms": round(elapsed_ms, 2),
            "hpo_loaded_at": _HPO_LOADED_AT,
        },
    })
