"""Excel 3개 DB 파서.

일반(82) + 기타(70) + 희귀(376) 폐질환 데이터베이스에서
DiseaseProfile 객체 목록을 생성한다.

각 Excel은 3개 시트:
  ① 질병 리스트  — ICD, 분류, 가중치
  ② HPO 표현형 리스트  — HPO 코드, 증상, 빈도
  ③ 영상·진단 포인트  — X-ray/CT/Lab/키워드/미생물 소견

헤더: row 2 (header=1), row 1은 시트 제목.
HPO 시트: 병합셀 패턴 → forward-fill 필요.
"""

from __future__ import annotations

import re
from typing import Any

import pandas as pd

from ..domain.disease import DiseaseProfile
from ..domain.enums import DiseaseCategory


def _safe_str(val: Any) -> str:
    """NaN / None → 빈 문자열."""
    if pd.isna(val):
        return ""
    return str(val).strip()


def _safe_list(val: Any) -> list[str]:
    """NaN → [], 문자열 → 빈 값 제거된 리스트."""
    s = _safe_str(val)
    if not s or s == "—" or s == "-":
        return []
    return [x.strip() for x in re.split(r"[|,;]", s) if x.strip() and x.strip() != "—"]


def _parse_weights(weight_str: str) -> dict[str, float]:
    """'S:0.25 L:0.15 R:0.30 M:0.30' → dict."""
    result = {}
    for m in re.finditer(r"([SLRM]):\s*([\d.]+)", weight_str):
        key_map = {"S": "symptoms", "L": "lab", "R": "radiology", "M": "micro"}
        result[key_map[m.group(1)]] = float(m.group(2))
    return result


def _normalize_key(name_en: str, icd10: str = "") -> str:
    """영문 질병명 → snake_case 키."""
    if not name_en:
        name_en = icd10
    key = re.sub(r"[^a-zA-Z0-9\s]", "", name_en.lower())
    key = re.sub(r"\s+", "_", key.strip())
    return key[:80] if key else "unknown"


def _parse_icd10(val: Any) -> list[str]:
    """ICD-10 셀 → 코드 리스트. 여러 코드가 , 또는 공백으로 분리될 수 있음."""
    s = _safe_str(val)
    if not s:
        return []
    return [c.strip() for c in re.split(r"[,;\s]+", s) if c.strip()]


def _parse_genes(val: Any) -> list[str]:
    """유전자 셀 파싱 (쉼표/세미콜론 구분)."""
    s = _safe_str(val)
    if not s or s == "—":
        return []
    return [g.strip() for g in re.split(r"[,;/]", s) if g.strip() and g.strip() != "—"]


# ═══════════════════════════════════════════════════════════════
# 일반/기타 질환 로더
# ═══════════════════════════════════════════════════════════════
def load_common_or_other_diseases(
    xlsx_path: str,
    category: DiseaseCategory,
) -> list[DiseaseProfile]:
    """일반 또는 기타 폐질환 Excel → DiseaseProfile 리스트.

    일반: 82개, 기타: 70개. 3개 시트 구조 동일.
    """
    # ── Sheet 1: 질병 리스트 ──────────────────────────────────
    df1 = pd.read_excel(xlsx_path, sheet_name=0, header=1)
    df1.columns = df1.columns.str.strip()

    # ── Sheet 2: HPO 표현형 리스트 ────────────────────────────
    df2 = pd.read_excel(xlsx_path, sheet_name=1, header=1)
    df2.columns = df2.columns.str.strip()
    # Forward-fill 병합셀 패턴
    for col in ["ICD-10", "ICD-11", "ICD-9", "한국어 질병명", "영문 질병명"]:
        if col in df2.columns:
            df2[col] = df2[col].ffill()

    # ── Sheet 3: 영상·진단 포인트 ─────────────────────────────
    df3 = pd.read_excel(xlsx_path, sheet_name=2, header=1)
    df3.columns = df3.columns.str.strip()

    # ICD-10 기준으로 Sheet 2, 3을 인덱싱
    hpo_by_icd = {}
    for _, row in df2.iterrows():
        icd = _safe_str(row.get("ICD-10"))
        if not icd:
            continue
        hpo_by_icd.setdefault(icd, []).append({
            "hpo_id": _safe_str(row.get("HPO 코드")),
            "hpo_term": _safe_str(row.get("HPO 영문 증상명")),
            "hpo_kr": _safe_str(row.get("HPO 한국어 증상명")),
            "frequency": _safe_str(row.get("빈도/발현율")),
        })

    imaging_by_icd = {}
    for _, row in df3.iterrows():
        icd = _safe_str(row.get("ICD-10"))
        if icd:
            imaging_by_icd[icd] = row

    # ── 조합 ──────────────────────────────────────────────────
    profiles = []
    for _, row in df1.iterrows():
        icd10_str = _safe_str(row.get("ICD-10"))
        if not icd10_str:
            continue

        name_en = _safe_str(row.get("영문 질병명"))
        name_kr = _safe_str(row.get("한국어 질병명"))
        disease_key = _normalize_key(name_en, icd10_str)

        # 가중치 파싱
        weight_str = _safe_str(row.get("진단 가중치 (S/L/R/M)"))
        weights = _parse_weights(weight_str)

        # 분류 (일반: "분류", 기타: "챕터/분류")
        classification = _safe_str(
            row.get("분류") or row.get("챕터/분류") or ""
        )

        # HPO
        hpo_list = hpo_by_icd.get(icd10_str, [])
        symptoms = list({h["hpo_term"] for h in hpo_list if h["hpo_term"]})

        # 영상·진단 포인트
        img_row = imaging_by_icd.get(icd10_str)
        xray_kr = ""
        xray_en = ""
        ct = ""
        diag_points = ""
        refs = ""
        lab_patterns: list[str] = []
        ai_keywords: list[str] = []
        micro_findings: list[str] = []

        if img_row is not None:
            xray_kr = _safe_str(img_row.get("X-ray 소견 (한국어)"))
            xray_en = _safe_str(img_row.get("X-ray 소견 (영문)"))
            ct = _safe_str(img_row.get("CT 소견"))
            diag_points = _safe_str(img_row.get("진단 포인트"))
            refs = _safe_str(img_row.get("참고문헌"))
            lab_patterns = _safe_list(
                img_row.get("Lab 패턴 (YAML)") or img_row.get("Lab 패턴")
            )
            ai_keywords = _safe_list(img_row.get("영상 키워드 (AI 매칭)"))
            micro_findings = _safe_list(img_row.get("미생물 소견"))

        # ── v5 차단 메타 읽기 (진단활성/제외사유/제외근거/차단카테고리) ──
        active_label = _safe_str(row.get("진단활성 (Active)"))
        is_blocked = active_label.startswith("NO") if active_label else False
        exclusion_category = ""
        if is_blocked and "(" in active_label and ")" in active_label:
            exclusion_category = active_label.split("(", 1)[1].rstrip(")")
        exclusion_reason = _safe_str(row.get("제외사유 (Reason)"))
        exclusion_reference = _safe_str(row.get("제외근거 (Reference)"))

        profiles.append(DiseaseProfile(
            disease_key=disease_key,
            name_en=name_en,
            name_kr=name_kr,
            category=category,
            icd10_codes=_parse_icd10(icd10_str),
            icd11_code=_safe_str(row.get("ICD-11")),
            icd9_code=_safe_str(row.get("ICD-9")),
            weight_symptoms=weights.get("symptoms", 0.25),
            weight_lab=weights.get("lab", 0.20),
            weight_radiology=weights.get("radiology", 0.35),
            weight_micro=weights.get("micro", 0.20),
            symptoms=symptoms,
            hpo_phenotypes=hpo_list,
            lab_patterns=lab_patterns,
            radiology_xray_en=xray_en,
            radiology_xray_kr=xray_kr,
            radiology_ct=ct,
            ai_imaging_keywords=ai_keywords,
            micro_findings=micro_findings,
            diagnostic_points=diag_points,
            references=refs,
            classification=classification,
            diagnostic_active=not is_blocked,
            exclusion_category=exclusion_category,
            exclusion_reason=exclusion_reason,
            exclusion_reference=exclusion_reference,
        ))

    return profiles


# ═══════════════════════════════════════════════════════════════
# 희귀질환 로더
# ═══════════════════════════════════════════════════════════════
def load_rare_diseases(xlsx_path: str) -> list[DiseaseProfile]:
    """희귀 폐질환 Excel → DiseaseProfile 리스트 (376개).

    Sheet 1: OrphaCode, 유전형, 주요 유전자 등 추가 컬럼.
    Sheet 2: HPO 빈도가 HP:00402xx 코드로 표기.
    Sheet 3: 17개 컬럼 (주요 유전자, 유전형, 특이 임상 소견, 예후/치료 포함).
    """
    # ── Sheet 1: 질병 리스트 ──────────────────────────────────
    df1 = pd.read_excel(xlsx_path, sheet_name=0, header=1)
    df1.columns = df1.columns.str.strip()

    # ── Sheet 2: HPO 표현형 리스트 ────────────────────────────
    df2 = pd.read_excel(xlsx_path, sheet_name=1, header=1)
    df2.columns = df2.columns.str.strip()
    for col in ["ICD-10", "ICD-11", "ICD-9", "한국어 질병명", "영문 질병명"]:
        if col in df2.columns:
            df2[col] = df2[col].ffill()

    # ── Sheet 3: 영상·진단 포인트 ─────────────────────────────
    df3 = pd.read_excel(xlsx_path, sheet_name=2, header=1)
    df3.columns = df3.columns.str.strip()

    # 인덱싱: 영문 질병명 기준 (희귀질환은 ICD-10 누락 많아서 영문명 사용)
    hpo_by_name: dict[str, list[dict]] = {}
    for _, row in df2.iterrows():
        name_en = _safe_str(row.get("영문 질병명"))
        if not name_en:
            continue
        hpo_by_name.setdefault(name_en, []).append({
            "hpo_id": _safe_str(row.get("HPO 코드")),
            "hpo_term": _safe_str(row.get("HPO 영문 증상명")),
            "hpo_kr": _safe_str(row.get("HPO 한국어 증상명")),
            "frequency": _safe_str(row.get("빈도/발현율")),
        })

    imaging_by_name: dict[str, Any] = {}
    for _, row in df3.iterrows():
        name_en = _safe_str(row.get("영문 질병명"))
        if name_en:
            imaging_by_name[name_en] = row

    # ── 조합 ──────────────────────────────────────────────────
    profiles = []
    for _, row in df1.iterrows():
        name_en = _safe_str(row.get("영문 질병명"))
        if not name_en:
            continue

        name_kr = _safe_str(row.get("한국어 질병명"))
        icd10_str = _safe_str(row.get("ICD-10"))
        disease_key = _normalize_key(name_en, icd10_str)

        # HPO
        hpo_list = hpo_by_name.get(name_en, [])
        symptoms = list({h["hpo_term"] for h in hpo_list if h["hpo_term"]})

        # 영상·진단 포인트
        img_row = imaging_by_name.get(name_en)
        xray_kr = ""
        xray_en = ""
        ct = ""
        diag_points = ""
        refs = ""
        lab_patterns: list[str] = []
        ai_keywords: list[str] = []
        micro_findings: list[str] = []
        special_clinical = ""
        prognosis = ""
        genes_from_sheet3: list[str] = []
        genetic_type_sheet3 = ""

        if img_row is not None:
            xray_kr = _safe_str(img_row.get("X-ray 소견 (한국어)"))
            xray_en = _safe_str(img_row.get("X-ray 소견 (영문)"))
            ct = _safe_str(img_row.get("CT 소견"))
            diag_points = _safe_str(img_row.get("진단 포인트"))
            refs = _safe_str(img_row.get("참고문헌"))
            lab_patterns = _safe_list(img_row.get("Lab 패턴"))
            ai_keywords = _safe_list(img_row.get("영상 키워드 (AI 매칭)"))
            micro_findings = _safe_list(img_row.get("미생물 소견"))
            special_clinical = _safe_str(img_row.get("특이 임상 소견"))
            prognosis = _safe_str(img_row.get("예후/치료"))
            genes_from_sheet3 = _parse_genes(img_row.get("주요 유전자"))
            genetic_type_sheet3 = _safe_str(img_row.get("유전형"))

        # Sheet 1의 유전자/유전형 (Sheet 3보다 Sheet 1 우선)
        genes_sheet1 = _parse_genes(row.get("주요 유전자"))
        genetic_type_sheet1 = _safe_str(row.get("유전형"))

        profiles.append(DiseaseProfile(
            disease_key=disease_key,
            name_en=name_en,
            name_kr=name_kr,
            category=DiseaseCategory.RARE,
            icd10_codes=_parse_icd10(icd10_str),
            icd11_code=_safe_str(row.get("ICD-11")),
            icd9_code=_safe_str(row.get("ICD-9")),
            # 희귀질환은 명시적 가중치 없음 → 기본값 유지
            symptoms=symptoms,
            hpo_phenotypes=hpo_list,
            lab_patterns=lab_patterns,
            radiology_xray_en=xray_en,
            radiology_xray_kr=xray_kr,
            radiology_ct=ct,
            ai_imaging_keywords=ai_keywords,
            micro_findings=micro_findings,
            diagnostic_points=diag_points,
            references=refs,
            classification=_safe_str(row.get("분류")),
            # 희귀질환 전용 필드
            orpha_code=_safe_str(row.get("OrphaCode")) or None,
            genetic_type=genetic_type_sheet1 or genetic_type_sheet3 or None,
            major_genes=genes_sheet1 or genes_from_sheet3,
            onset_age=_safe_str(row.get("발병 연령")) or None,
            prevalence=_safe_str(row.get("유병률")) or None,
            special_clinical_findings=special_clinical,
            prognosis_treatment=prognosis,
        ))

    return profiles
