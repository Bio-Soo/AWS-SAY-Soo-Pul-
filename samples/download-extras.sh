#!/usr/bin/env bash
# Download the heavy artifacts (model checkpoints, MIMIC lab CSVs, full CheXpert) that aren't bundled in this repo.
# Requires AWS CLI + access to the source bucket.
set -e
[ -f ../.env ] || { echo "Need ../.env"; exit 1; }
source ../.env

SRC=${EXTRAS_SOURCE_BUCKET:-say2-2team-bucket}
DEST="${1:-./extras}"

mkdir -p "$DEST"/{models,mimic-csv,chexpert-images}

echo "=== Phase 2 model checkpoints (~240 MB) ==="
aws s3 cp "s3://$SRC/Phase_2/latest_checkpoint.pth"       "$DEST/models/" --quiet &
aws s3 cp "s3://$SRC/Phase_2/anatomy_soonet_v5_best.pth"  "$DEST/models/" --quiet &
aws s3 cp "s3://$SRC/Phase_2/unet_lung_heart_best.pth"    "$DEST/models/" --quiet &
wait

echo "=== MIMIC lab CSVs (~6 GB) — UNCOMMENT below if you actually need these ==="
# aws s3 cp "s3://$SRC/lab data/labevents.csv.gz"       "$DEST/mimic-csv/"
# aws s3 cp "s3://$SRC/lab data/chartevents.csv.gz"     "$DEST/mimic-csv/"
# aws s3 cp "s3://$SRC/lab data/d_labitems.csv"         "$DEST/mimic-csv/"
# aws s3 cp "s3://$SRC/lab data/d_items.csv.gz"         "$DEST/mimic-csv/"

echo "=== Sample CheXpert images (100 images, ~13 MB) ==="
aws s3 ls "s3://$SRC/cheXpert_data/preprocessed_512/images/" | head -100 | awk '{print $4}' | \
  xargs -I {} aws s3 cp "s3://$SRC/cheXpert_data/preprocessed_512/images/{}" "$DEST/chexpert-images/" --quiet

echo "=== Mock EMR all patients (~500 KB) ==="
aws s3 sync "s3://$SRC/mock-emr/patients/" "$DEST/mock-patients/" --quiet

echo ""
echo "✓ Extras downloaded to $DEST"
du -sh "$DEST"/*
