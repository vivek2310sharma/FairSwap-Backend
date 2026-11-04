#!/bin/bash
set -euo pipefail

MODELS_DIR="${1:-models}"
mkdir -p "${MODELS_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

DET_URL="https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar"
REC_URL="https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_rec_infer.tar"
CLS_URL="https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar"

echo "Downloading PaddleOCR model archives..."
curl -fsSL "${DET_URL}" -o "${TMP_DIR}/en_PP-OCRv3_det_infer.tar"
curl -fsSL "${REC_URL}" -o "${TMP_DIR}/en_PP-OCRv3_rec_infer.tar"
curl -fsSL "${CLS_URL}" -o "${TMP_DIR}/ch_ppocr_mobile_v2.0_cls_infer.tar"

echo "Verifying archive SHA-256 checksums..."
CHECKSUMS_FILE="$(mktemp)"
cat << 'EOF' > "${CHECKSUMS_FILE}"
e740eb522521827cc83da3ba33e1c70ccfd9b3cf7d9a24a420ce4ca5ebb8794f  TMP_DIR/en_PP-OCRv3_det_infer.tar
94402088520ae3938c51eb8782da1cd7c1bc46d5531766de99f77ee9c2f23343  TMP_DIR/en_PP-OCRv3_rec_infer.tar
507352585040d035da3b1e6374694ad679a850acb0a36a8d0d47984176357717  TMP_DIR/ch_ppocr_mobile_v2.0_cls_infer.tar
EOF

sed -i.bak "s|TMP_DIR|${TMP_DIR}|g" "${CHECKSUMS_FILE}"
rm -f "${CHECKSUMS_FILE}.bak"

if command -v sha256sum > /dev/null 2>&1; then
  sha256sum -c "${CHECKSUMS_FILE}"
else
  shasum -a 256 -c "${CHECKSUMS_FILE}"
fi
rm -f "${CHECKSUMS_FILE}"

echo "Extracting model directories into ${MODELS_DIR}..."
tar -xf "${TMP_DIR}/en_PP-OCRv3_det_infer.tar" -C "${MODELS_DIR}"
tar -xf "${TMP_DIR}/en_PP-OCRv3_rec_infer.tar" -C "${MODELS_DIR}"
tar -xf "${TMP_DIR}/ch_ppocr_mobile_v2.0_cls_infer.tar" -C "${MODELS_DIR}"

echo "Verifying extracted inference model assets..."
EXTRACTED_CHECKSUMS="$(mktemp)"
cat << 'EOF' > "${EXTRACTED_CHECKSUMS}"
c4bfb1b05d9d1d5a760801eaf6d20180ef7e47bcc675fb17d1f3a89da5fef427  MODELS_DIR/en_PP-OCRv3_det_infer/inference.pdmodel
83676ec730627ab4502f401410a4b6a3ce1c0bb98fa249b71db055b6bddae051  MODELS_DIR/en_PP-OCRv3_det_infer/inference.pdiparams
f0288362f754e815030929477f7b1f96fe2e913e197537288a01bd43f768d0ab  MODELS_DIR/en_PP-OCRv3_rec_infer/inference.pdmodel
2cea2de604d8a75fd9151b54ea2dd027659fb8cb777cde377224581110dbff13  MODELS_DIR/en_PP-OCRv3_rec_infer/inference.pdiparams
3c4337ec61722a20b1dca2e5bfaffc313c0592bc89ad6e0d45168224186f6683  MODELS_DIR/ch_ppocr_mobile_v2.0_cls_infer/inference.pdmodel
d1efda1b80e174b4fcb168a035ac96c1af4938892bd86a55f300a6027105d08c  MODELS_DIR/ch_ppocr_mobile_v2.0_cls_infer/inference.pdiparams
EOF

sed -i.bak "s|MODELS_DIR|${MODELS_DIR}|g" "${EXTRACTED_CHECKSUMS}"
rm -f "${EXTRACTED_CHECKSUMS}.bak"

if command -v sha256sum > /dev/null 2>&1; then
  sha256sum -c "${EXTRACTED_CHECKSUMS}"
else
  shasum -a 256 -c "${EXTRACTED_CHECKSUMS}"
fi
rm -f "${EXTRACTED_CHECKSUMS}"

echo "All PaddleOCR model assets downloaded and verified successfully."
