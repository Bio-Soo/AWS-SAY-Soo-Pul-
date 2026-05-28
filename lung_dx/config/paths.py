"""파일 경로 상수 및 MIMIC-IV ItemID 정의."""

from pathlib import Path

# ── 프로젝트 루트 ──────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parents[2]  # say2-2-preproject/
# YAML/Excel reference 파일은 say2-2-preproject/data/ 에 위치
DATA_DIR = PROJECT_ROOT / "data"
# MIMIC-IV CSV 등 대용량 데이터는 별도 폴더 (필요 시)
DATA_ORIGIN = PROJECT_ROOT / "MIMIC-IV data_origin"

# ── YAML Reference 파일 ───────────────────────────────────────
# v3 expansion (2026-04-07): profiles/symptoms 17 → 49 diseases,
# lab v3 → v4 with bidirectional disease_associations sync,
# vitals v1 → v2 with new disease coverage. v2 paths kept for backcompat.
LAB_REFERENCE_YAML = DATA_DIR / "lab_reference_ranges_v9_5.yaml"  # v9.5: micro panel +11 (β-D-glucan/GM/PCP/Flu/RSV/Myco/Chl/CrAg/NTM/AspIgG) + K→N 정리 (2026-04-30)
VITALS_REFERENCE_YAML = DATA_DIR / "vitals_respiratory_hemodynamic_reference_range_v3.yaml"
DISEASE_PROFILES_YAML = DATA_DIR / "lung_disease_profiles_v3_6.yaml"  # v3.6: sub_code_radiology_findings 신규 필드 (B 옵션 schema 확장) — sub-code별 영상 hallmark 분리 (10 카테고리 / 35 sub-codes 적용, fact 기반: Tschopp ERS 2015 / Fleischner 2024 / Raghu HP 2020 / BTS 등). Camus reference 정정 포함 (2026-05-19)
# DISEASE_SYMPTOMS_YAML 제거 (2026-05-06): profiles_v3_2.hpo_phenotypes가 49/49 풀로 채워진 후 redundant.
# v3 원본은 data/obsoleted/lung_disease_symptoms_v3.yaml로 이동.
DISEASE_PROFILES_YAML_V3 = DATA_DIR / "lung_disease_profiles_v3.yaml"  # backcompat
DISEASE_PROFILES_YAML_V3_1 = DATA_DIR / "lung_disease_profiles_v3_1.yaml"  # backcompat
DISEASE_PROFILES_YAML_V3_2 = DATA_DIR / "lung_disease_profiles_v3_2.yaml"  # backcompat (pre GOLD 2026 weights)
DISEASE_PROFILES_YAML_V3_3 = DATA_DIR / "lung_disease_profiles_v3_3.yaml"  # backcompat (pre PMID fabrication fix)
DISEASE_PROFILES_YAML_V3_4 = DATA_DIR / "lung_disease_profiles_v3_4.yaml"  # backcompat (pre 누락 영상 토큰 추가)
DISEASE_PROFILES_YAML_V3_5 = DATA_DIR / "lung_disease_profiles_v3_5.yaml"  # backcompat (pre B 옵션 schema 확장)

# ── Phase 2 CheXpert 14 카테고리 expansion reference (Option E, 2026-05-14) ──
# Phase 3 어댑터(phase3_multimodal/chexpert_adapter.py)가 사용. 의학 evidence
# (Fleischner 2024 PMID 38411514, ATS/IDSA CAP 2019 PMID 31573350, Komiya
# 2017 PMID 28841896, BTS Pleural 2023 PMID 37553157 등) 부착.
CHEXPERT_LABEL_REFERENCE_YAML = DATA_DIR / "chexpert_label_reference_v1.yaml"

# ── Phase 1 (문진 → HPO) 데이터 자산 (2026-04-29 추가) ─────────
KOREAN_HPO_DICTIONARY = DATA_DIR / "korean_hpo_dictionary_v1.json"  # 한국어 → HP IDs (402 terms)
MULTILINGUAL_PHENOTYPE_LEXICON = DATA_DIR / "multilingual_phenotype_lexicon_v1.json"  # 한/영/의학용어/약어 (952 keys)
ICD10_REFERENCE = DATA_DIR / "icd10_reference_v1.json"  # ICD-10 sub-code 표준 명칭 (504 codes)

# ── Backward compatibility (older versions preserved) ──────────
LAB_REFERENCE_YAML_V3 = DATA_DIR / "lab_reference_ranges_v3.yaml"
LAB_REFERENCE_YAML_V4 = DATA_DIR / "lab_reference_ranges_v4.yaml"
LAB_REFERENCE_YAML_V5 = DATA_DIR / "lab_reference_ranges_v5.yaml"
LAB_REFERENCE_YAML_V6 = DATA_DIR / "lab_reference_ranges_v6.yaml"
LAB_REFERENCE_YAML_V7 = DATA_DIR / "lab_reference_ranges_v7.yaml"
LAB_REFERENCE_YAML_V8 = DATA_DIR / "lab_reference_ranges_v8.yaml"
LAB_REFERENCE_YAML_V9 = DATA_DIR / "lab_reference_ranges_v9.yaml"
LAB_REFERENCE_YAML_V9_1 = DATA_DIR / "lab_reference_ranges_v9_1.yaml"
LAB_REFERENCE_YAML_V9_2 = DATA_DIR / "lab_reference_ranges_v9_2.yaml"
LAB_REFERENCE_YAML_V9_3 = DATA_DIR / "lab_reference_ranges_v9_3.yaml"
LAB_REFERENCE_YAML_V9_4 = DATA_DIR / "lab_reference_ranges_v9_4.yaml"  # backcompat
LAB_REFERENCE_YAML_V9_5 = DATA_DIR / "lab_reference_ranges_v9_5.yaml"  # 활성 (옵션 C 적용)
VITALS_REFERENCE_YAML_V1 = DATA_DIR / "vitals_respiratory_hemodynamic_reference_range_v1.yaml"
VITALS_REFERENCE_YAML_V2 = DATA_DIR / "vitals_respiratory_hemodynamic_reference_range_v2.yaml"
DISEASE_PROFILES_YAML_V2 = DATA_DIR / "lung_disease_profiles_v2.yaml"
DISEASE_SYMPTOMS_YAML_V2 = DATA_DIR / "lung_disease_symptoms_v2.yaml"

# ── Excel Disease Databases ───────────────────────────────────
COMMON_DISEASE_XLSX = DATA_DIR / "일반_폐질환_데이터베이스_v9.xlsx"  # v9: Q22 제거 (기타 DB v9와 동기화, 변경 0건 단순 bump, 2026-05-19) / v8: GOLD 2026 v1.3 기반 COPD/Emphysema/Chronic bronchitis weights 재설계 (J41/J43/J44 7행, 2026-05-14)
OTHER_DISEASE_XLSX = DATA_DIR / "기타_폐관련_질환_데이터베이스_v9.xlsx"  # v9: Q22 (폐동맥판/삼첨판 선천기형) 제거 — 의학적 fact 기반 (WHO ICD-10 Chapter XVII 순환계 + AHA/ACC ACHD 2018 + ESC ACHD 2020) (2026-05-19) / v8: 변경 없음 버전 bump
RARE_DISEASE_XLSX = DATA_DIR / "희귀_폐질환_데이터베이스_v5.xlsx"  # v5: 다른 팀원 작업 영역
# backcompat (older versions preserved)
COMMON_DISEASE_XLSX_V4 = DATA_DIR / "일반_폐질환_데이터베이스_v4.xlsx"
OTHER_DISEASE_XLSX_V4 = DATA_DIR / "기타_폐관련_질환_데이터베이스_v4.xlsx"
COMMON_DISEASE_XLSX_V5 = DATA_DIR / "일반_폐질환_데이터베이스_v5.xlsx"
OTHER_DISEASE_XLSX_V5 = DATA_DIR / "기타_폐관련_질환_데이터베이스_v5.xlsx"
COMMON_DISEASE_XLSX_V6 = DATA_DIR / "일반_폐질환_데이터베이스_v6.xlsx"
OTHER_DISEASE_XLSX_V6 = DATA_DIR / "기타_폐관련_질환_데이터베이스_v6.xlsx"
COMMON_DISEASE_XLSX_V7 = DATA_DIR / "일반_폐질환_데이터베이스_v7.xlsx"  # backcompat (pre GOLD 2026 weights)
OTHER_DISEASE_XLSX_V7 = DATA_DIR / "기타_폐관련_질환_데이터베이스_v7.xlsx"  # backcompat (pre GOLD 2026 weights)
RARE_DISEASE_XLSX_V4 = DATA_DIR / "희귀_폐질환_데이터베이스_v4.xlsx"

# ── MIMIC-IV 환자 측정값 CSV ──────────────────────────────────
# 항목 정의·reference range는 위 2개 YAML에 이미 완비되어 있음.
# d_items.csv, d_labitems.csv 등 MIMIC lookup 테이블은 사용하지 않음.
# CSV는 순수하게 환자 측정값 데이터 소스로만 활용.
CHARTEVENTS_CSV = DATA_ORIGIN / "chartevents.csv"
LABEVENTS_CSV = DATA_ORIGIN / "labevents.csv"

# ── 캐시 / 출력 디렉토리 ──────────────────────────────────────
CACHE_DIR = PROJECT_ROOT / "lung_dx" / "cache"
PARQUET_DIR = CACHE_DIR / "parquets"
MODEL_DIR = CACHE_DIR / "models"
REPORT_DIR = PROJECT_ROOT / "reports"

# ── CheXpert 14 Labels (Stanford CheXpert) ────────────────────
CHEXPERT_LABELS = [
    "Atelectasis",
    "Cardiomegaly",
    "Consolidation",
    "Edema",
    "Enlarged Cardiomediastinum",
    "Fracture",
    "Lung Lesion",
    "Lung Opacity",
    "No Finding",
    "Pleural Effusion",
    "Pleural Other",
    "Pneumonia",
    "Pneumothorax",
    "Support Devices",
]

# ── ItemID 목록 ──────────────────────────────────────────────
# Lab ItemID:   lab_reference_ranges_v3.yaml에서 동적 로드
#               89개 (MIMIC-IV 53개 + 외부 EXT_A~EXT_AJ 36개)
#               미생물(J카테고리) 10개 항목 포함
# Vitals/Respiratory/Hemodynamic ItemID:
#               vitals_respiratory_hemodynamic_reference_range_v1.yaml
#               에서 동적 로드 (37개)

# ── 미생물 참조 ──────────────────────────────────────────────
# micro 관련 reference range 및 threshold는
# lab_reference_ranges_v3.yaml의 J_Infection_Microbiology 카테고리
# (10개 항목: Blood Culture, Sputum Culture, AFB, TB-PCR, IGRA,
#  Aspergillus GM, Beta-D-Glucan, COVID-19 RT-PCR/Rapid PCR/Ag)
# + Excel DB "미생물 소견" 컬럼 + YAML micro_findings에서 참조
# (microbiologyevents.csv는 사용하지 않음)
