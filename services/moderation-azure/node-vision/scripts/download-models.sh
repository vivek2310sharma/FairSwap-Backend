#!/bin/bash
set -euo pipefail

MODELS_DIR="${1:-models}"
mkdir -p "${MODELS_DIR}/nsfwjs"
mkdir -p "${MODELS_DIR}/mobilenet_v2"

# 1. NSFWJS (MobileNetV2 Quantized)
NSFW_BASE_URL="https://raw.githubusercontent.com/infinitered/nsfwjs/master/models/mobilenet_v2"
echo "Downloading NSFWJS model assets..."
curl -fsSL "${NSFW_BASE_URL}/model.json" -o "${MODELS_DIR}/nsfwjs/model.json"
curl -fsSL "${NSFW_BASE_URL}/group1-shard1of1" -o "${MODELS_DIR}/nsfwjs/group1-shard1of1"

# 2. MobileNetV2 (1.00 Multiplier, 224x224)
MOBILENET_BASE_URL="https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224"
echo "Downloading MobileNetV2 model assets..."
curl -fsSL "${MOBILENET_BASE_URL}/model.json" -o "${MODELS_DIR}/mobilenet_v2/model.json"
curl -fsSL "${MOBILENET_BASE_URL}/group1-shard1of4" -o "${MODELS_DIR}/mobilenet_v2/group1-shard1of4"
curl -fsSL "${MOBILENET_BASE_URL}/group1-shard2of4" -o "${MODELS_DIR}/mobilenet_v2/group1-shard2of4"
curl -fsSL "${MOBILENET_BASE_URL}/group1-shard3of4" -o "${MODELS_DIR}/mobilenet_v2/group1-shard3of4"
curl -fsSL "${MOBILENET_BASE_URL}/group1-shard4of4" -o "${MODELS_DIR}/mobilenet_v2/group1-shard4of4"

echo "Verifying model SHA-256 checksums..."
CHECKSUMS_FILE="$(mktemp)"
cat << 'EOF' > "${CHECKSUMS_FILE}"
11846416217e68bf1eb7b0e651bcfd305973566453c63275bbd16766ab089979  MODELS_DIR/nsfwjs/model.json
8e7dddbb16acacc1bf1601b1b8a761e730ff934b7f2d7771312b2f000e5f5f13  MODELS_DIR/nsfwjs/group1-shard1of1
12e180771864a87473ae06988b8564d9fd077b11c1854030e90509917203cf6f  MODELS_DIR/mobilenet_v2/model.json
b837ab72b76b59e217750e0afed94b8f877fce7fff71b8d9cead71fc11612d8c  MODELS_DIR/mobilenet_v2/group1-shard1of4
4b9b02a59ecfea1a698a576f1400e876170ef78abe0e06b16195ebfe2983f6d5  MODELS_DIR/mobilenet_v2/group1-shard2of4
fab6533531d17b78ad67223c82d9a452263ccc4d309a20db91a5de3714aa6a00  MODELS_DIR/mobilenet_v2/group1-shard3of4
617fd3639ac5cfb94a971bef032fcdfa7690816d524117f54a9cc693d0b2c5f4  MODELS_DIR/mobilenet_v2/group1-shard4of4
EOF

sed -i.bak "s|MODELS_DIR|${MODELS_DIR}|g" "${CHECKSUMS_FILE}"
rm -f "${CHECKSUMS_FILE}.bak"

if command -v sha256sum > /dev/null 2>&1; then
  sha256sum -c "${CHECKSUMS_FILE}"
else
  shasum -a 256 -c "${CHECKSUMS_FILE}"
fi

rm -f "${CHECKSUMS_FILE}"
echo "All model checksums verified successfully."
